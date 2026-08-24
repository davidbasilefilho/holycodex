// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runManagedProcess,
  type ManagedProcessInput,
  type ManagedProcessResult,
} from "@holycodex/runtime-core";
import {
  decodeResponse,
  encodeRequest,
  SafeFilesystemErrorResponseSchema,
  SafeFilesystemListResponseSchema,
  SafeFilesystemManifestSchema,
  SafeFilesystemMutationResponseSchema,
  SafeFilesystemReadResponseSchema,
  SafeFilesystemStatResponseSchema,
  SafeFilesystemVersionResponseSchema,
  SAFE_FILESYSTEM_HELPER_VERSION,
  SAFE_FILESYSTEM_MAX_FILE_BYTES,
  SAFE_FILESYSTEM_MAX_LINE_BYTES,
  SAFE_FILESYSTEM_PROTOCOL_VERSION,
  type SafeFilesystemErrorCode,
  type SafeFilesystemManifest,
  type SafeFilesystemOperation,
  type SafeFilesystemRequest,
} from "./protocol.ts";

export type SafeFilesystemPlatform = "posix" | "win32";

export type SafeWorkflowDirectoryEntry = Readonly<{
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}>;

export type SafeWorkflowFilesystemBoundary = Readonly<{
  readonly assertOwnedPath: (
    root: string,
    candidate: string,
    allowMissing: boolean,
  ) => Promise<void>;
  readonly ensureDirectory: (root: string, candidate: string) => Promise<void>;
  readonly writeAtomicFile: (root: string, candidate: string, bytes: Uint8Array) => Promise<void>;
  readonly readOwnedFile: (root: string, candidate: string) => Promise<Uint8Array>;
  readonly readDirectory: (
    root: string,
    candidate: string,
  ) => Promise<readonly SafeWorkflowDirectoryEntry[]>;
  readonly removeOwnedDirectory: (root: string, candidate: string) => Promise<void>;
}>;

export type SafeFilesystemRunner = (input: ManagedProcessInput) => Promise<ManagedProcessResult>;

export type SafeFilesystemClientOptions = Readonly<{
  readonly platform?: SafeFilesystemPlatform;
  readonly helperPath?: string;
  readonly manifest?: SafeFilesystemManifest;
  readonly runner?: SafeFilesystemRunner;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
}>;

export type PackagedSafeFilesystemHelper = Readonly<{
  readonly assetDirectory: string;
  readonly manifestPath: string;
}>;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_CHARS = SAFE_FILESYSTEM_MAX_LINE_BYTES;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const WINDOWS_DRIVE = /^[A-Za-z]:$/u;
const MAX_HELPER_BYTES = 64 * 1024 * 1024;

export class SafeFilesystemError extends Error {
  readonly code: SafeFilesystemErrorCode;
  readonly operation: SafeFilesystemOperation;
  readonly causeValue: unknown;

  constructor(
    code: SafeFilesystemErrorCode,
    operation: SafeFilesystemOperation,
    message: string,
    causeValue?: unknown,
  ) {
    super(message);
    this.name = "SafeFilesystemError";
    this.code = code;
    this.operation = operation;
    this.causeValue = causeValue;
  }
}

type ResolvedHelper = Readonly<{
  readonly helperPath: string;
  readonly manifestPath: string;
  readonly manifest: SafeFilesystemManifest | undefined;
}>;

export class SafeFilesystemClient {
  private readonly platform: SafeFilesystemPlatform;
  private readonly runner: SafeFilesystemRunner;
  private helper: ResolvedHelper | undefined;
  private readonly helperLocation: PackagedSafeFilesystemHelper | undefined;
  private readonly providedManifest: SafeFilesystemManifest | undefined;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private capability: Promise<void> | undefined;
  private readonly rootIdentities = new Map<string, string>();

  constructor(options: SafeFilesystemClientOptions = {}) {
    this.platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
    this.timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Safe filesystem helper timeout",
      DEFAULT_TIMEOUT_MS,
    );
    this.maxOutputChars = boundedInteger(
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      "Safe filesystem helper output bound",
      DEFAULT_MAX_OUTPUT_CHARS,
    );
    this.providedManifest = options.manifest;
    this.runner = options.runner ?? runManagedProcess;
    if (options.helperPath !== undefined && options.runner === undefined) {
      this.helper = {
        ...resolveExplicitHelper(options.helperPath, this.platform),
        manifest: options.manifest,
      };
    } else if (options.runner === undefined) {
      this.helperLocation = resolvePackagedHelper(this.platform);
    } else {
      this.helperLocation = undefined;
    }
  }

  asBoundary(): SafeWorkflowFilesystemBoundary {
    return Object.freeze({
      assertOwnedPath: async (root, candidate, allowMissing) =>
        await this.assertOwnedPath(root, candidate, allowMissing),
      ensureDirectory: async (root, candidate) => await this.ensureDirectory(root, candidate),
      writeAtomicFile: async (root, candidate, bytes) =>
        await this.writeAtomicFile(root, candidate, bytes),
      readOwnedFile: async (root, candidate) => await this.readOwnedFile(root, candidate),
      readDirectory: async (root, candidate) => await this.readDirectory(root, candidate),
      removeOwnedDirectory: async (root, candidate) =>
        await this.removeOwnedDirectory(root, candidate),
    });
  }

  async assertOwnedPath(root: string, candidate: string, allowMissing: boolean): Promise<void> {
    const target = this.target(root, candidate, "statDigest");
    const rootIdentity = await this.ensureRootIdentity(target.root);
    const response = await this.invoke({
      version: SAFE_FILESYSTEM_PROTOCOL_VERSION,
      op: "statDigest",
      root: target.root,
      target: target.relative,
      root_identity: rootIdentity,
      allow_missing: allowMissing,
    });
    const statResponse = decodeTyped(SafeFilesystemStatResponseSchema, response, "statDigest");
    if (!statResponse.exists) {
      if (allowMissing) return;
      throw new SafeFilesystemError("not_found", "statDigest", "The owned path does not exist.");
    }
    if (statResponse.kind === "symlink" || statResponse.kind === "other") {
      throw new SafeFilesystemError(
        "link_reparse",
        "statDigest",
        "The owned path is a link, reparse point, or unsupported file type.",
      );
    }
  }

  async ensureDirectory(root: string, candidate: string): Promise<void> {
    const target = this.target(root, candidate, "createSessionDir");
    const rootIdentity = await this.ensureRootIdentity(target.root);
    if (target.relative.length === 0) return;
    await this.invoke({
      version: SAFE_FILESYSTEM_PROTOCOL_VERSION,
      op: "createSessionDir",
      root: target.root,
      target: target.relative,
      root_identity: rootIdentity,
    });
  }

  async writeAtomicFile(root: string, candidate: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > SAFE_FILESYSTEM_MAX_FILE_BYTES) {
      throw new SafeFilesystemError(
        "invalid_input",
        "atomicWrite",
        "The atomic write exceeds the safe filesystem size limit.",
      );
    }
    const target = this.target(root, candidate, "atomicWrite");
    if (target.relative.length === 0) {
      throw new SafeFilesystemError("invalid_path", "atomicWrite", "The atomic target is a root.");
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const rootIdentity = await this.ensureRootIdentity(target.root);
    const digest = sha256(copy);
    await this.invoke({
      version: SAFE_FILESYSTEM_PROTOCOL_VERSION,
      op: "atomicWrite",
      root: target.root,
      target: target.relative,
      root_identity: rootIdentity,
      data: encodeBase64(copy),
      expected_digest: digest,
    });
  }

  async readOwnedFile(root: string, candidate: string): Promise<Uint8Array> {
    const target = this.target(root, candidate, "readFile");
    if (target.relative.length === 0) {
      throw new SafeFilesystemError(
        "not_regular_file",
        "readFile",
        "The owned root is not a file.",
      );
    }
    const rootIdentity = await this.ensureRootIdentity(target.root);
    const response = await this.invoke({
      version: SAFE_FILESYSTEM_PROTOCOL_VERSION,
      op: "readFile",
      root: target.root,
      target: target.relative,
      root_identity: rootIdentity,
    });
    const parsed = decodeTyped(SafeFilesystemReadResponseSchema, response, "readFile");
    const bytes = decodeBase64(parsed.data, parsed.size);
    if (sha256(bytes) !== parsed.digest) {
      throw new SafeFilesystemError(
        "integrity_uncertain",
        "readFile",
        "The helper returned bytes with a mismatched digest.",
      );
    }
    return bytes;
  }

  async readDirectory(
    root: string,
    candidate: string,
  ): Promise<readonly SafeWorkflowDirectoryEntry[]> {
    const target = this.target(root, candidate, "listDirectory");
    const rootIdentity = await this.ensureRootIdentity(target.root);
    const response = await this.invoke({
      version: SAFE_FILESYSTEM_PROTOCOL_VERSION,
      op: "listDirectory",
      root: target.root,
      target: target.relative,
      root_identity: rootIdentity,
    });
    const parsed = decodeTyped(SafeFilesystemListResponseSchema, response, "listDirectory");
    const seenNames = new Map<string, string>();
    return parsed.entries.map((entry) => {
      if (!isSafeComponent(entry.name, this.platform)) {
        throw new SafeFilesystemError(
          "link_reparse",
          "listDirectory",
          "The helper enumerated an unsafe directory entry.",
        );
      }
      const folded = entry.name.toLocaleLowerCase("en-US");
      const previous = seenNames.get(folded);
      if (previous !== undefined && previous !== entry.name) {
        throw new SafeFilesystemError(
          "conflict",
          "listDirectory",
          "The helper enumerated case-folded colliding directory entries.",
        );
      }
      seenNames.set(folded, entry.name);
      return { ...entry };
    });
  }

  async removeOwnedDirectory(root: string, candidate: string): Promise<void> {
    const target = this.target(root, candidate, "removeSessionTree");
    if (target.relative.length === 0) {
      throw new SafeFilesystemError(
        "invalid_path",
        "removeSessionTree",
        "The owned root cannot be removed as a session tree.",
      );
    }
    const rootIdentity = await this.ensureRootIdentity(target.root);
    await this.invoke({
      version: SAFE_FILESYSTEM_PROTOCOL_VERSION,
      op: "removeSessionTree",
      root: target.root,
      target: target.relative,
      root_identity: rootIdentity,
    });
  }

  private async ensureRootIdentity(root: string): Promise<string> {
    const current = this.rootIdentities.get(root);
    if (current !== undefined) return current;
    const response = await this.invoke({
      version: SAFE_FILESYSTEM_PROTOCOL_VERSION,
      op: "ensureRoot",
      root,
    });
    const parsed = decodeTyped(SafeFilesystemMutationResponseSchema, response, "ensureRoot");
    if (parsed.root_identity === undefined) {
      throw new SafeFilesystemError(
        "protocol_error",
        "ensureRoot",
        "The helper did not return a root identity.",
      );
    }
    this.rootIdentities.set(root, parsed.root_identity);
    return parsed.root_identity;
  }

  private async invoke(request: SafeFilesystemRequest): Promise<unknown> {
    if (request.op !== "version") await this.ensureCapability();
    const operation = request.op;
    const helperPath = this.helper?.helperPath ?? "safe-filesystem";
    const result = await this.runner({
      command: helperPath,
      args: [],
      platform: this.platform,
      timeoutMs: this.timeoutMs,
      maxOutputChars: this.maxOutputChars,
      stdin: encodeRequest(request),
    });
    if (result.timedOut || result.aborted || result.outputTruncated || result.error !== undefined) {
      throw new SafeFilesystemError(
        result.timedOut || result.aborted ? "capability_unavailable" : "io_error",
        operation,
        result.error ?? "The safe filesystem helper did not complete within its bounds.",
        result,
      );
    }
    if (result.exitCode !== 0) {
      throw new SafeFilesystemError(
        operation === "version" || result.errorCode === "ENOENT"
          ? "capability_unavailable"
          : "io_error",
        operation,
        result.stderr || `The safe filesystem helper exited with ${String(result.exitCode)}.`,
        result,
      );
    }
    const response = parseSingleJsonLine(result.stdout, operation);
    let decoded: ReturnType<typeof decodeResponse>;
    try {
      decoded = decodeResponse(response);
    } catch (error: unknown) {
      throw new SafeFilesystemError(
        operation === "version" ? "capability_unavailable" : "protocol_error",
        operation,
        "The safe filesystem helper returned an invalid protocol response.",
        error,
      );
    }
    if (isErrorResponse(decoded)) {
      throw new SafeFilesystemError(decoded.code, operation, decoded.message);
    }
    return decoded;
  }

  private async ensureCapability(): Promise<void> {
    if (this.capability === undefined) this.capability = this.checkCapability();
    await this.capability;
  }

  private async checkCapability(): Promise<void> {
    await this.resolveHelper();
    if (this.helper !== undefined) {
      const manifest = this.helper.manifest ?? (await readManifest(this.helper.manifestPath));
      if (
        manifest.platform !== (this.platform === "win32" ? "win32" : "linux") ||
        manifest.architecture !== "x64" ||
        manifest.executable !==
          (this.platform === "win32" ? "safe-filesystem.exe" : "safe-filesystem")
      ) {
        throw new SafeFilesystemError(
          "capability_unavailable",
          "version",
          "The staged safe filesystem helper manifest targets the wrong artifact.",
        );
      }
      await verifyHelperDigest(this.helper.helperPath, manifest);
      this.helper = { ...this.helper, manifest };
    }
    const response = await this.invoke({
      version: SAFE_FILESYSTEM_PROTOCOL_VERSION,
      op: "version",
    });
    const version = decodeTyped(SafeFilesystemVersionResponseSchema, response, "version");
    if (
      version.helper_version !== SAFE_FILESYSTEM_HELPER_VERSION ||
      version.protocol_version !== SAFE_FILESYSTEM_PROTOCOL_VERSION
    ) {
      throw new SafeFilesystemError(
        "capability_unavailable",
        "version",
        "The safe filesystem helper reported an unsupported version.",
      );
    }
    if (
      this.helper?.manifest !== undefined &&
      version.source_sha256 !== this.helper.manifest.sourceSha256
    ) {
      throw new SafeFilesystemError(
        "capability_unavailable",
        "version",
        "The safe filesystem helper source identity does not match its manifest.",
      );
    }
  }

  private async resolveHelper(): Promise<void> {
    if (this.helper !== undefined || this.helperLocation === undefined) return;
    const manifest =
      this.providedManifest ?? (await readManifest(this.helperLocation.manifestPath));
    if (
      manifest.platform !== (this.platform === "win32" ? "win32" : "linux") ||
      manifest.architecture !== "x64" ||
      manifest.executable !==
        (this.platform === "win32" ? "safe-filesystem.exe" : "safe-filesystem")
    ) {
      throw new SafeFilesystemError(
        "capability_unavailable",
        "version",
        "The packaged safe filesystem helper targets a different platform.",
      );
    }
    const helperPath = join(this.helperLocation.assetDirectory, manifest.executable);
    this.helper = {
      helperPath,
      manifestPath: this.helperLocation.manifestPath,
      manifest,
    };
  }

  private target(
    root: string,
    candidate: string,
    operation: SafeFilesystemOperation,
  ): Readonly<{ readonly root: string; readonly relative: string }> {
    try {
      return relativeTarget(root, candidate, this.platform);
    } catch (error: unknown) {
      if (error instanceof SafeFilesystemError) throw error;
      throw new SafeFilesystemError(
        "invalid_path",
        operation,
        error instanceof Error ? error.message : "The safe filesystem path is invalid.",
        error,
      );
    }
  }
}

export function createSafeWorkflowFilesystemBoundary(
  options: SafeFilesystemClientOptions = {},
): SafeWorkflowFilesystemBoundary {
  return new SafeFilesystemClient(options).asBoundary();
}

export const createPackagedSafeWorkflowFilesystemBoundary = createSafeWorkflowFilesystemBoundary;

export function resolvePackagedHelper(
  platform: SafeFilesystemPlatform,
): PackagedSafeFilesystemHelper {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const key = `${platform === "win32" ? "win32" : "linux"}-x64`;
  const assetDirectory = join(moduleDirectory, "assets", "safe-filesystem", key);
  return { assetDirectory, manifestPath: join(assetDirectory, "manifest.json") };
}

function resolveExplicitHelper(path: string, platform: SafeFilesystemPlatform): ResolvedHelper {
  const api = platform === "win32" ? win32 : posix;
  if (path.includes("\0") || !api.isAbsolute(path) || hasDotComponent(path, platform)) {
    throw new SafeFilesystemError(
      "invalid_path",
      "version",
      "The helper path must be absolute and safe.",
    );
  }
  const normalized = api.normalize(path);
  const expectedName = platform === "win32" ? "safe-filesystem.exe" : "safe-filesystem";
  if (api.basename(normalized) !== expectedName) {
    throw new SafeFilesystemError(
      "invalid_path",
      "version",
      "The helper path is not the staged safe filesystem executable.",
    );
  }
  return {
    helperPath: normalized,
    manifestPath: join(dirname(normalized), "manifest.json"),
    manifest: undefined,
  };
}

async function readManifest(path: string): Promise<SafeFilesystemManifest> {
  let raw: unknown;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("manifest size/type");
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new SafeFilesystemError(
      "capability_unavailable",
      "version",
      "The packaged safe filesystem helper manifest is unavailable.",
      error,
    );
  }
  const decoded = Schema.decodeUnknownEither(SafeFilesystemManifestSchema, {
    onExcessProperty: "error",
  })(raw);
  if (Either.isLeft(decoded)) {
    throw new SafeFilesystemError(
      "capability_unavailable",
      "version",
      "The packaged safe filesystem helper manifest is invalid.",
      decoded.left,
    );
  }
  return decoded.right;
}

async function verifyHelperDigest(path: string, manifest: SafeFilesystemManifest): Promise<void> {
  let file: Uint8Array;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_HELPER_BYTES) {
      throw new Error("helper size/type");
    }
    file = await readFile(path);
  } catch (error: unknown) {
    throw new SafeFilesystemError(
      "capability_unavailable",
      "version",
      "The packaged safe filesystem helper cannot be inspected.",
      error,
    );
  }
  if (sha256(file) !== manifest.helperSha256) {
    throw new SafeFilesystemError(
      "capability_unavailable",
      "version",
      "The packaged safe filesystem helper digest does not match its manifest.",
    );
  }
}

function relativeTarget(
  root: string,
  candidate: string,
  platform: SafeFilesystemPlatform,
): Readonly<{ readonly root: string; readonly relative: string }> {
  validateAbsoluteRoot(root, platform);
  const api = platform === "win32" ? win32 : posix;
  if (
    candidate.includes("\0") ||
    !api.isAbsolute(candidate) ||
    hasDotComponent(candidate, platform)
  ) {
    throw new Error("The safe filesystem candidate must be absolute, NUL-free, and dot-free.");
  }
  if (platform === "win32" && isWindowsDeviceOrUnc(candidate)) {
    throw new Error("Device, UNC, and extended Windows paths are not accepted.");
  }
  const normalizedRoot = api.normalize(root);
  const normalizedCandidate = api.normalize(candidate);
  const relative =
    platform === "win32"
      ? win32.relative(normalizedRoot.toLowerCase(), normalizedCandidate.toLowerCase())
      : posix.relative(normalizedRoot, normalizedCandidate);
  if (relative.length === 0) return { root: normalizedRoot, relative: "" };
  if (
    api.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("The safe filesystem candidate escaped its owned root.");
  }
  const components = relative.split(platform === "win32" ? /[\\/]/u : /\//u);
  if (components.some((component) => !isSafeComponent(component, platform))) {
    throw new Error("The safe filesystem candidate contains an unsafe component.");
  }
  return { root: normalizedRoot, relative: components.join("/") };
}

function validateAbsoluteRoot(root: string, platform: SafeFilesystemPlatform): void {
  const api = platform === "win32" ? win32 : posix;
  if (
    root.includes("\0") ||
    !api.isAbsolute(root) ||
    hasDotComponent(root, platform) ||
    (platform === "win32" && isWindowsDeviceOrUnc(root))
  ) {
    throw new Error("The safe filesystem root must be an absolute, local, dot-free path.");
  }
  const normalized = api.normalize(root);
  if (normalized === api.dirname(normalized))
    throw new Error("The safe filesystem root is too broad.");
  const components =
    platform === "win32"
      ? normalized.split("\\").filter((component) => component.length > 0)
      : normalized.split("/").filter((component) => component.length > 0);
  const names =
    platform === "win32" && WINDOWS_DRIVE.test(components[0] ?? "")
      ? components.slice(1)
      : components;
  if (names.some((component) => !isSafeRootComponent(component, platform))) {
    throw new Error("The safe filesystem root contains an unsafe component.");
  }
}

function isSafeComponent(value: string, platform: SafeFilesystemPlatform): boolean {
  if (!SAFE_COMPONENT.test(value) || value === "." || value === "..") return false;
  if (platform === "win32" && (WINDOWS_RESERVED.test(value) || /[.: ]$/u.test(value))) return false;
  return true;
}

function isSafeRootComponent(value: string, platform: SafeFilesystemPlatform): boolean {
  const candidate = value.startsWith(".") ? value.slice(1) : value;
  if (candidate.length === 0 || !SAFE_COMPONENT.test(candidate)) return false;
  if (platform === "win32" && (WINDOWS_RESERVED.test(candidate) || /[.: ]$/u.test(candidate))) {
    return false;
  }
  return true;
}

function hasDotComponent(value: string, platform: SafeFilesystemPlatform): boolean {
  const components = value.split(platform === "win32" ? /[\\/]/u : /\//u);
  return components.some((component) => component === "." || component === "..");
}

function isWindowsDeviceOrUnc(value: string): boolean {
  return (
    value.startsWith("\\\\") ||
    value.startsWith("\\\\?\\") ||
    value.startsWith("\\\\.\\") ||
    /^[A-Za-z]:[^\\/]/u.test(value)
  );
}

function parseSingleJsonLine(stdout: string, operation: SafeFilesystemOperation): unknown {
  if (
    stdout.length === 0 ||
    new TextEncoder().encode(stdout).byteLength > SAFE_FILESYSTEM_MAX_LINE_BYTES
  ) {
    throw new SafeFilesystemError(
      "protocol_error",
      operation,
      "The helper response exceeded its bound.",
    );
  }
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new SafeFilesystemError(
      "protocol_error",
      operation,
      "The helper returned more than one response.",
    );
  }
  try {
    return JSON.parse(lines[0] ?? "") as unknown;
  } catch (error: unknown) {
    throw new SafeFilesystemError(
      "protocol_error",
      operation,
      "The helper response was not JSON.",
      error,
    );
  }
}

function decodeTyped<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  operation: SafeFilesystemOperation,
): A {
  const decoded = Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(value);
  if (Either.isLeft(decoded)) {
    throw new SafeFilesystemError(
      "protocol_error",
      operation,
      "The helper response failed protocol validation.",
      decoded.left,
    );
  }
  return decoded.right;
}

function isErrorResponse(value: unknown): value is typeof SafeFilesystemErrorResponseSchema.Type {
  return Schema.is(SafeFilesystemErrorResponseSchema)(value);
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string, expectedSize: number): Uint8Array {
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) ||
    value.length % 4 !== 0 ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > SAFE_FILESYSTEM_MAX_FILE_BYTES
  ) {
    throw new SafeFilesystemError(
      "protocol_error",
      "readFile",
      "The helper returned invalid base64 data.",
    );
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.byteLength !== expectedSize) {
    throw new SafeFilesystemError(
      "protocol_error",
      "readFile",
      "The helper returned an invalid byte count.",
    );
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedInteger(value: number, label: string, fallback: number): number {
  if (value === fallback) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > SAFE_FILESYSTEM_MAX_LINE_BYTES) {
    throw new SafeFilesystemError("invalid_input", "version", `${label} is invalid.`);
  }
  return value;
}
