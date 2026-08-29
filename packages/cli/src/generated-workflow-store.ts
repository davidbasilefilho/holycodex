// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import { createHash, randomBytes } from "node:crypto";
import { join, posix, resolve, win32 } from "node:path";
import { canonicalJson } from "@holycodex/core";
import { createPackagedSafeWorkflowFilesystemBoundary } from "@holycodex/safe-filesystem";
import { isFsCode, pathWithin, type ResolvedInstallerPaths } from "./paths.ts";
import { decodeSchema, DateTextSchema, DigestSchema } from "./schema.ts";

export const GENERATED_WORKFLOW_SCHEMA_EPOCH = "workflow-store-1.0" as const;
export const GENERATED_WORKFLOW_NAMING_VERSION = "workflow-name-v1" as const;
export const GENERATED_WORKFLOW_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GENERATED_WORKFLOW_MAX_SOURCE_BYTES = 1024 * 1024;
export const GENERATED_WORKFLOW_MAX_SESSION_ID_BYTES = 96;
export const GENERATED_WORKFLOW_MAX_NAME_BYTES = 64;

const SafeSegmentSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u));
const SafeWorkflowNameSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
);
const ShortHashSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{4}$/u));
const NativeWorkflowIdentitySchema = Schema.Struct({
  source_sha256: DigestSchema,
  ir_sha256: DigestSchema,
  graph_sha256: DigestSchema,
  codec_profile_sha256: DigestSchema,
  abi_version: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)),
  execution_mode: Schema.Literal("native"),
});

const GeneratedWorkflowMetadataSchema = Schema.Struct({
  schema_epoch: Schema.Literal(GENERATED_WORKFLOW_SCHEMA_EPOCH),
  naming_version: Schema.Literal(GENERATED_WORKFLOW_NAMING_VERSION),
  owner_session_id: SafeSegmentSchema,
  safe_name: SafeWorkflowNameSchema,
  short_hash: ShortHashSchema,
  source_sha256: DigestSchema,
  source_path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  created_at: DateTextSchema,
  last_access_at: DateTextSchema,
  expires_at: DateTextSchema,
  active: Schema.Boolean,
  native_identity: Schema.optional(NativeWorkflowIdentitySchema),
});
export type GeneratedWorkflowMetadata = typeof GeneratedWorkflowMetadataSchema.Type;

export type NativeWorkflowStoredIdentity = typeof NativeWorkflowIdentitySchema.Type;

export type SafeWorkflowFilesystemBoundary = Readonly<{
  /** The checked-in native helper validates the root-relative handle chain. */
  readonly assertOwnedPath: (
    root: string,
    candidate: string,
    allowMissing: boolean,
  ) => Promise<void>;
  /** The helper creates an owned directory without recursive path substitution. */
  readonly ensureDirectory: (root: string, candidate: string) => Promise<void>;
  /** The helper stages, fsyncs, and atomically installs bytes using owned handles. */
  readonly writeAtomicFile: (root: string, candidate: string, bytes: Uint8Array) => Promise<void>;
  /** The helper reads a regular file through an owned no-follow handle. */
  readonly readOwnedFile: (root: string, candidate: string) => Promise<Uint8Array>;
  /** The helper enumerates one owned directory without following links. */
  readonly readDirectory: (
    root: string,
    candidate: string,
  ) => Promise<readonly SafeWorkflowDirectoryEntry[]>;
  /** The helper removes one owned directory through a root-relative handle. */
  readonly removeOwnedDirectory: (root: string, candidate: string) => Promise<void>;
}>;

export type SafeWorkflowDirectoryEntry = Readonly<{
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}>;

export type GeneratedWorkflowStoreOptions = Readonly<{
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly platform?: "posix" | "win32";
  readonly boundary?: SafeWorkflowFilesystemBoundary;
}>;

export type StoredGeneratedWorkflow = Readonly<{
  readonly metadata: GeneratedWorkflowMetadata;
  readonly source: string;
}>;

export type GeneratedWorkflowCleanupResult = Readonly<{
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
  readonly uncertain: readonly string[];
}>;

export class GeneratedWorkflowStore {
  readonly root: string;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly platform: "posix" | "win32";
  private readonly boundary: SafeWorkflowFilesystemBoundary | undefined;

  constructor(
    stateRootOrPaths: string | Pick<ResolvedInstallerPaths, "stateRoot">,
    options: GeneratedWorkflowStoreOptions = {},
  ) {
    const stateRoot =
      typeof stateRootOrPaths === "string" ? stateRootOrPaths : stateRootOrPaths.stateRoot;
    if (stateRoot.includes("\0") || stateRoot.split(/[\\/]/u).some((segment) => segment === "..")) {
      throw new GeneratedWorkflowStoreError(
        "invalid_path",
        "The generated workflow store root cannot contain lexical traversal or NUL bytes.",
      );
    }
    const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
    assertSafeAbsolutePath(stateRoot, platform, "workflow state root");
    this.root = join(resolve(stateRoot), "workflows");
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? GENERATED_WORKFLOW_DEFAULT_TTL_MS;
    this.platform = platform;
    this.boundary =
      options.boundary ??
      createPackagedSafeWorkflowFilesystemBoundary({
        platform,
      });
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new GeneratedWorkflowStoreError(
        "invalid_input",
        "Generated workflow retention must be a positive safe integer.",
      );
    }
    assertSafeAbsolutePath(this.root, this.platform, "workflow store root");
  }

  async put(sessionId: string, safeName: string, source: string): Promise<StoredGeneratedWorkflow> {
    const ownerSessionId = assertSafeSessionId(sessionId);
    const name = assertSafeWorkflowName(safeName);
    if (typeof source !== "string" || source.length === 0) {
      throw new GeneratedWorkflowStoreError("invalid_input", "Generated workflow source is empty.");
    }
    const bytes = new TextEncoder().encode(source);
    if (bytes.byteLength > GENERATED_WORKFLOW_MAX_SOURCE_BYTES) {
      throw new GeneratedWorkflowStoreError(
        "invalid_input",
        "Generated workflow source exceeds the size limit.",
      );
    }
    await this.ensureRoot();
    const sessionDirectory = join(this.root, ownerSessionId);
    await this.assertCaseSafeDirectory(this.root, ownerSessionId);
    await this.ensureOwnedDirectory(sessionDirectory);
    await this.assertCaseSafeDirectory(sessionDirectory, name);
    const sourceSha256 = sha256(bytes);
    const now = this.now();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const shortHash = await shortWorkflowHash(ownerSessionId, name, sourceSha256, attempt);
      const fileName = `${name}-${shortHash}.ts`;
      const sourcePath = join(sessionDirectory, fileName);
      const metadataPath = `${sourcePath}.metadata.json`;
      const existing = await this.readMetadataIfPresent(metadataPath);
      if (existing !== undefined) {
        const existingBytes = await this.readOwnedBytes(sourcePath);
        if (sha256(existingBytes) !== sourceSha256) continue;
        if (
          existing.owner_session_id !== ownerSessionId ||
          existing.safe_name !== name ||
          existing.short_hash !== shortHash ||
          existing.source_path !== sourcePath
        ) {
          throw new GeneratedWorkflowStoreError(
            "collision",
            "The generated workflow name collides with different persisted metadata.",
          );
        }
        const refreshed = await this.writeMetadata({
          ...existing,
          last_access_at: now.toISOString(),
          expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
          active: true,
        });
        return { metadata: refreshed, source: new TextDecoder().decode(existingBytes) };
      }
      try {
        await this.readOwnedBytes(sourcePath);
        continue;
      } catch (error: unknown) {
        if (!isMissingPath(error)) throw error;
      }
      await this.writeAtomicBytes(sourcePath, bytes);
      const metadata = await this.writeMetadata({
        schema_epoch: GENERATED_WORKFLOW_SCHEMA_EPOCH,
        naming_version: GENERATED_WORKFLOW_NAMING_VERSION,
        owner_session_id: ownerSessionId,
        safe_name: name,
        short_hash: shortHash,
        source_sha256: sourceSha256,
        source_path: sourcePath,
        created_at: now.toISOString(),
        last_access_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
        active: true,
      });
      const verified = await this.readOwnedBytes(sourcePath);
      if (sha256(verified) !== sourceSha256) {
        throw new GeneratedWorkflowStoreError(
          "integrity_uncertain",
          "The generated workflow failed post-write digest verification.",
        );
      }
      return { metadata, source: new TextDecoder().decode(verified) };
    }
    throw new GeneratedWorkflowStoreError(
      "collision",
      "The generated workflow short hash collided with different source bytes.",
    );
  }

  async read(sourcePath: string): Promise<StoredGeneratedWorkflow> {
    const normalized = this.assertOwnedSourcePath(sourcePath);
    const metadata = await this.readMetadata(`${normalized}.metadata.json`);
    if (metadata.source_path !== normalized) {
      throw new GeneratedWorkflowStoreError(
        "integrity_uncertain",
        "The generated workflow metadata path does not match the requested path.",
      );
    }
    const bytes = await this.readOwnedBytes(normalized);
    if (sha256(bytes) !== metadata.source_sha256) {
      throw new GeneratedWorkflowStoreError(
        "integrity_uncertain",
        "The generated workflow source digest does not match metadata.",
      );
    }
    const now = this.now();
    const refreshed = await this.writeMetadata({
      ...metadata,
      last_access_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
      active: true,
    });
    return { metadata: refreshed, source: new TextDecoder().decode(bytes) };
  }

  async recordNativeIdentity(
    sourcePath: string,
    identity: NativeWorkflowStoredIdentity,
  ): Promise<GeneratedWorkflowMetadata> {
    const normalized = this.assertOwnedSourcePath(sourcePath);
    const metadata = await this.readMetadata(`${normalized}.metadata.json`);
    const bytes = await this.readOwnedBytes(normalized);
    const sourceSha256 = sha256(bytes);
    if (sourceSha256 !== metadata.source_sha256 || identity.source_sha256 !== sourceSha256) {
      throw new GeneratedWorkflowStoreError(
        "integrity_uncertain",
        "The generated workflow source changed before native identity persistence.",
      );
    }
    return await this.writeMetadata({ ...metadata, native_identity: identity });
  }

  async setSessionActivity(sessionId: string, active: boolean): Promise<void> {
    const ownerSessionId = assertSafeSessionId(sessionId);
    const directory = join(this.root, ownerSessionId);
    await this.assertOwnedPath(directory, true);
    const entries = await this.readOwnedDirectory(directory).catch((error: unknown) => {
      if (isMissingPath(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.kind !== "file" || !entry.name.endsWith(".ts.metadata.json")) continue;
      const metadataPath = join(directory, entry.name);
      const metadata = await this.readMetadata(metadataPath);
      const now = this.now();
      await this.writeMetadata({
        ...metadata,
        active,
        last_access_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
      });
    }
  }

  async sessionEnd(sessionId: string): Promise<void> {
    const ownerSessionId = assertSafeSessionId(sessionId);
    const directory = join(this.root, ownerSessionId);
    await this.assertOwnedPath(directory, true);
    try {
      const entry = (await this.readOwnedDirectory(this.root)).find(
        (candidate) => candidate.name === ownerSessionId,
      );
      if (entry === undefined) return;
      if (entry.kind !== "directory") {
        throw new GeneratedWorkflowStoreError(
          "integrity_uncertain",
          "The generated workflow session is not an owned directory.",
        );
      }
      await this.assertTree(directory);
      await this.requireBoundary().removeOwnedDirectory(this.root, directory);
    } catch (error: unknown) {
      if (isMissingPath(error)) return;
      if (error instanceof GeneratedWorkflowStoreError) throw error;
      throw new GeneratedWorkflowStoreError(
        "storage_failure",
        "The generated workflow session could not be removed.",
        error,
      );
    }
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const ownerSessionId = assertSafeSessionId(sessionId);
    const directory = join(this.root, ownerSessionId);
    await this.assertOwnedPath(this.root, true);
    try {
      const entry = (await this.readOwnedDirectory(this.root)).find(
        (candidate) => candidate.name === ownerSessionId,
      );
      if (entry === undefined) return false;
      if (entry.kind !== "directory") {
        throw new GeneratedWorkflowStoreError(
          "integrity_uncertain",
          "The generated workflow session is not an owned directory.",
        );
      }
      await this.assertOwnedPath(directory, false);
      return true;
    } catch (error: unknown) {
      if (isMissingPath(error)) return false;
      throw error;
    }
  }

  async cleanupExpired(
    options: Readonly<{ preview?: boolean; maxEntries?: number; maxMs?: number }> = {},
  ): Promise<GeneratedWorkflowCleanupResult> {
    await this.ensureRoot();
    const preview = options.preview ?? false;
    const maxEntries = options.maxEntries ?? 128;
    const maxMs = options.maxMs ?? 250;
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries <= 0 ||
      !Number.isSafeInteger(maxMs) ||
      maxMs <= 0
    ) {
      throw new GeneratedWorkflowStoreError(
        "invalid_input",
        "Generated workflow cleanup bounds are invalid.",
      );
    }
    const started = Date.now();
    const removed: string[] = [];
    const preserved: string[] = [];
    const uncertain: string[] = [];
    const entries = await this.readOwnedDirectory(this.root);
    let inspected = 0;
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (inspected >= maxEntries || Date.now() - started >= maxMs) break;
      if (entry.kind !== "directory") {
        if (entry.name !== "user.json" && entry.name !== "project.json")
          uncertain.push(join(this.root, entry.name));
        continue;
      }
      inspected += 1;
      if (!isSafeSegment(entry.name)) {
        uncertain.push(join(this.root, entry.name));
        continue;
      }
      const directory = join(this.root, entry.name);
      try {
        await this.assertOwnedPath(directory, false);
        await this.assertTree(directory);
        const metadata = await this.readSessionMetadata(directory);
        if (
          metadata.length === 0 ||
          metadata.some((item) => item.active || Date.parse(item.expires_at) > this.now().getTime())
        ) {
          preserved.push(directory);
          continue;
        }
        if (!preview) {
          await this.requireBoundary().removeOwnedDirectory(this.root, directory);
        }
        removed.push(directory);
      } catch (error: unknown) {
        if (isMissingPath(error)) continue;
        uncertain.push(directory);
      }
    }
    return { removed, preserved, uncertain };
  }

  ownsPath(candidate: string): boolean {
    const normalized = normalizeForPlatform(candidate, this.platform);
    return pathWithin(this.root, normalized, this.platform) && normalized.endsWith(".ts");
  }

  private async ensureRoot(): Promise<void> {
    await this.assertBoundaryOrFailClosed(this.root, true);
    await this.requireBoundary().ensureDirectory(this.root, this.root);
    await this.assertOwnedPath(this.root, false);
  }

  private async ensureOwnedDirectory(directory: string): Promise<void> {
    await this.assertBoundaryOrFailClosed(directory, true);
    await this.requireBoundary().ensureDirectory(this.root, directory);
    await this.assertOwnedPath(directory, false);
  }

  private async assertBoundaryOrFailClosed(
    candidate: string,
    allowMissing: boolean,
  ): Promise<void> {
    if (this.boundary === undefined) {
      throw new GeneratedWorkflowStoreError(
        "needs_root_decision",
        `${this.platform === "win32" ? "Windows generated workflow storage requires the checked-in Win32 reparse-safe handle helper" : "POSIX generated workflow storage requires directory-relative no-follow handles"}; lstat/realpath checks are insufficient for this operation.`,
      );
    }
    await this.assertOwnedPath(candidate, allowMissing);
  }

  private async assertOwnedPath(candidate: string, allowMissing: boolean): Promise<void> {
    if (this.boundary === undefined) {
      throw new GeneratedWorkflowStoreError(
        "needs_root_decision",
        `${this.platform === "win32" ? "Windows generated workflow storage requires the checked-in Win32 reparse-safe handle helper" : "POSIX generated workflow storage requires directory-relative no-follow handles"}; lstat/realpath checks are insufficient for this operation.`,
      );
    }
    const normalized = normalizeForPlatform(candidate, this.platform);
    if (normalized !== this.root && !pathWithin(this.root, normalized, this.platform)) {
      throw new GeneratedWorkflowStoreError(
        "invalid_path",
        "The generated workflow path escaped its owned root.",
      );
    }
    try {
      await this.requireBoundary().assertOwnedPath(this.root, normalized, allowMissing);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "capability_unavailable"
      ) {
        throw new GeneratedWorkflowStoreError(
          "needs_root_decision",
          "The packaged safe filesystem helper is unavailable or has the wrong version.",
          error,
        );
      }
      throw error;
    }
  }

  private requireBoundary(): SafeWorkflowFilesystemBoundary {
    if (this.boundary === undefined) {
      throw new GeneratedWorkflowStoreError(
        "needs_root_decision",
        "The required safe filesystem boundary is unavailable.",
      );
    }
    return this.boundary;
  }

  private assertOwnedSourcePath(sourcePath: string): string {
    const normalized = normalizeForPlatform(sourcePath, this.platform);
    if (!this.ownsPath(normalized)) {
      throw new GeneratedWorkflowStoreError(
        "invalid_path",
        "The generated workflow source path is not owned.",
      );
    }
    return normalized;
  }

  private async readOwnedBytes(sourcePath: string): Promise<Uint8Array> {
    const normalized = this.assertOwnedSourcePath(sourcePath);
    await this.assertBoundaryOrFailClosed(normalized, false);
    return await this.requireBoundary().readOwnedFile(this.root, normalized);
  }

  private async readMetadataIfPresent(
    path: string,
  ): Promise<GeneratedWorkflowMetadata | undefined> {
    try {
      return await this.readMetadata(path);
    } catch (error: unknown) {
      if (isMissingPath(error)) return undefined;
      throw error;
    }
  }

  private async readMetadata(path: string): Promise<GeneratedWorkflowMetadata> {
    await this.assertBoundaryOrFailClosed(path, false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder().decode(await this.requireBoundary().readOwnedFile(this.root, path)),
      ) as unknown;
    } catch (error: unknown) {
      if (isMissingPath(error)) throw error;
      throw new GeneratedWorkflowStoreError(
        "malformed_metadata",
        "Generated workflow metadata is not valid JSON.",
        error,
      );
    }
    const metadata = decodeSchema(GeneratedWorkflowMetadataSchema, parsed);
    if (metadata === undefined) {
      throw new GeneratedWorkflowStoreError(
        "malformed_metadata",
        "Generated workflow metadata failed schema validation.",
      );
    }
    const expectedSourcePath = path.endsWith(".metadata.json")
      ? path.slice(0, -".metadata.json".length)
      : "";
    if (metadata.source_path !== expectedSourcePath || !this.ownsPath(metadata.source_path)) {
      throw new GeneratedWorkflowStoreError(
        "malformed_metadata",
        "Generated workflow metadata does not point to its owned source file.",
      );
    }
    return metadata;
  }

  private async writeMetadata(
    input: GeneratedWorkflowMetadata,
  ): Promise<GeneratedWorkflowMetadata> {
    const metadata = decodeSchema(GeneratedWorkflowMetadataSchema, input);
    if (metadata === undefined) {
      throw new GeneratedWorkflowStoreError(
        "malformed_metadata",
        "Generated workflow metadata is invalid.",
      );
    }
    await this.writeAtomicBytes(
      metadata.source_path + ".metadata.json",
      new TextEncoder().encode(`${canonicalJson(metadata)}\n`),
    );
    return metadata;
  }

  private async writeAtomicBytes(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizeForPlatform(path, this.platform);
    await this.assertBoundaryOrFailClosed(normalized, true);
    try {
      await this.requireBoundary().writeAtomicFile(this.root, normalized, bytes);
      const verified = await this.requireBoundary().readOwnedFile(this.root, normalized);
      if (sha256(verified) !== sha256(bytes)) {
        throw new GeneratedWorkflowStoreError(
          "integrity_uncertain",
          "Atomic generated workflow write verification failed.",
        );
      }
    } catch (error: unknown) {
      if (error instanceof GeneratedWorkflowStoreError) throw error;
      throw new GeneratedWorkflowStoreError(
        "storage_failure",
        "The generated workflow could not be atomically stored.",
        error,
      );
    }
  }

  private async assertCaseSafeDirectory(directory: string, segment: string): Promise<void> {
    const entries = await this.readOwnedDirectory(directory);
    const folded = foldCase(segment, this.platform);
    for (const entry of entries) {
      if (foldCase(entry.name, this.platform) === folded && entry.name !== segment) {
        throw new GeneratedWorkflowStoreError(
          "collision",
          "A case-folded generated workflow path collision was detected.",
        );
      }
    }
  }

  private async assertTree(directory: string): Promise<void> {
    const entries = await this.readOwnedDirectory(directory);
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      await this.assertOwnedPath(candidate, false);
      if (entry.kind === "symlink" || entry.kind === "other") {
        throw new GeneratedWorkflowStoreError(
          "integrity_uncertain",
          "A generated workflow session contains a symlink or reparse substitution.",
        );
      }
      if (entry.kind === "directory") await this.assertTree(candidate);
    }
  }

  private async readSessionMetadata(
    directory: string,
  ): Promise<readonly GeneratedWorkflowMetadata[]> {
    const entries = await this.readOwnedDirectory(directory);
    const result: GeneratedWorkflowMetadata[] = [];
    for (const entry of entries) {
      if (entry.kind !== "file" || !entry.name.endsWith(".ts.metadata.json")) continue;
      result.push(await this.readMetadata(join(directory, entry.name)));
    }
    return result;
  }

  private async readOwnedDirectory(
    directory: string,
  ): Promise<readonly SafeWorkflowDirectoryEntry[]> {
    await this.assertBoundaryOrFailClosed(directory, false);
    return await this.requireBoundary().readDirectory(this.root, directory);
  }
}

export function assertSafeSessionId(value: string): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > GENERATED_WORKFLOW_MAX_SESSION_ID_BYTES
  ) {
    throw new GeneratedWorkflowStoreError(
      "invalid_name",
      "The workflow session id exceeds its safe length.",
    );
  }
  const parsed = decodeSchema(SafeSegmentSchema, value);
  if (
    parsed === undefined ||
    value === "." ||
    value === ".." ||
    value === "user.json" ||
    value === "project.json"
  ) {
    throw new GeneratedWorkflowStoreError(
      "invalid_name",
      "The workflow session id is not filesystem-safe.",
    );
  }
  return parsed;
}

export function assertSafeWorkflowName(value: string): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > GENERATED_WORKFLOW_MAX_NAME_BYTES
  ) {
    throw new GeneratedWorkflowStoreError(
      "invalid_name",
      "The generated workflow name exceeds its safe length.",
    );
  }
  const parsed = decodeSchema(SafeWorkflowNameSchema, value);
  if (parsed === undefined || value === "." || value === "..") {
    throw new GeneratedWorkflowStoreError(
      "invalid_name",
      "The generated workflow name is not filesystem-safe.",
    );
  }
  return parsed;
}

export async function shortWorkflowHash(
  sessionId: string,
  safeName: string,
  sourceSha256: string,
  attempt = 0,
): Promise<string> {
  assertSafeSessionId(sessionId);
  assertSafeWorkflowName(safeName);
  if (decodeSchema(DigestSchema, sourceSha256) === undefined) {
    throw new GeneratedWorkflowStoreError("invalid_input", "The source digest is invalid.");
  }
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 15) {
    throw new GeneratedWorkflowStoreError("invalid_input", "The workflow hash attempt is invalid.");
  }
  return randomBytes(2).toString("hex");
}

function isMissingPath(error: unknown): boolean {
  return isFsCode(error, "ENOENT") || isFsCode(error, "not_found");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeAbsolutePath(value: string, platform: "posix" | "win32", label: string): void {
  const api = platform === "win32" ? win32 : posix;
  const normalized = api.normalize(value);
  if (value.includes("\0") || !api.isAbsolute(normalized)) {
    throw new GeneratedWorkflowStoreError(
      "invalid_path",
      `${label} must be an absolute path without NUL bytes.`,
    );
  }
  if (value.split(/[\\/]/u).some((segment) => segment === "..")) {
    throw new GeneratedWorkflowStoreError(
      "invalid_path",
      `${label} cannot contain lexical traversal.`,
    );
  }
}

function normalizeForPlatform(value: string, platform: "posix" | "win32"): string {
  if (value.includes("\0")) {
    throw new GeneratedWorkflowStoreError(
      "invalid_path",
      "A generated workflow path contains NUL bytes.",
    );
  }
  if (platform === "win32" && /^\/[A-Za-z](?:\/|$)/u.test(value)) {
    return `${value[1]?.toUpperCase() ?? ""}:${value.slice(2).replaceAll("/", "\\")}`;
  }
  return platform === "win32" ? win32.normalize(value) : resolve(value);
}

function foldCase(value: string, platform: "posix" | "win32"): string {
  return platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isSafeSegment(value: string): boolean {
  return decodeSchema(SafeSegmentSchema, value) !== undefined && value !== "." && value !== "..";
}

export class GeneratedWorkflowStoreError extends Error {
  readonly code:
    | "invalid_input"
    | "invalid_name"
    | "invalid_path"
    | "collision"
    | "malformed_metadata"
    | "integrity_uncertain"
    | "needs_root_decision"
    | "storage_failure";
  readonly causeValue: unknown;

  constructor(code: GeneratedWorkflowStoreError["code"], message: string, causeValue?: unknown) {
    super(message);
    this.name = "GeneratedWorkflowStoreError";
    this.code = code;
    this.causeValue = causeValue;
  }
}
