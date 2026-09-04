// SPDX-License-Identifier: Apache-2.0

import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalJsonUtf8, domainSeparatedSha256 } from "../packages/core/src/canonical.ts";
import {
  allowlistedEnvironment,
  DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  isSensitiveEnvironmentKey,
  redactDiagnostics,
  runChecked,
  withTemporaryDirectory,
} from "./process.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const generatedRoot = join(workspaceRoot, "packages/codex/generated");
const generatedTypescriptRoot = join(generatedRoot, "typescript");
const provenancePath = join(generatedRoot, "provenance.json");
const miseConfigPath = join(workspaceRoot, "mise.toml");
const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
const CODEX_VERSION_OUTPUT = /^codex-cli (\d+\.\d+\.\d+)$/u;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

interface GeneratedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface GeneratedInventory {
  readonly count: number;
  readonly digest: string;
  readonly files: readonly GeneratedFile[];
}

interface GeneratedProvenance {
  readonly schema_version: "holycodex-generated-v2";
  readonly artifact_root: "packages/codex/generated";
  readonly codex_cli_version: `codex-cli ${string}`;
  readonly codex_cli_digest: string;
  readonly protocol_epoch: `codex-app-server-${string}`;
  readonly generator: {
    readonly command: readonly ["app-server", "generate-ts"];
    readonly supported_surface: "codex app-server generators";
  };
  readonly typescript_root: "typescript";
  readonly files: { readonly count: number; readonly digest: string };
}

export interface EnsureCodexGeneratedResult {
  readonly status: "generated" | "reused";
  readonly codexCliVersion: string;
  readonly codexCliDigest: string;
  readonly artifactDigest: string;
  readonly artifactFiles: number;
}

export interface GeneratedCacheIdentity {
  readonly codexCliVersion: string;
  readonly codexCliDigest: string;
}

export function assertLatestStableMatch(latestVersion: string, installedVersion: string): void {
  assertStableVersion(latestVersion, "mise stable Codex metadata");
  assertStableVersion(installedVersion, "the installed Codex CLI version");
  if (latestVersion !== installedVersion) {
    throw new Error(
      `The installed Codex version ${installedVersion} is stale; mise stable metadata resolves ${latestVersion}. Run "mise install codex@latest" and retry.`,
    );
  }
}

export function canReuseGeneratedOutput(
  cached: GeneratedCacheIdentity,
  resolved: GeneratedCacheIdentity,
): boolean {
  return (
    cached.codexCliVersion === resolved.codexCliVersion &&
    cached.codexCliDigest === resolved.codexCliDigest
  );
}

let activeGeneration: Promise<EnsureCodexGeneratedResult> | undefined;

/**
 * Ensure local generated bindings match the stable Codex CLI resolved by the
 * stable mise channel. A valid current tree is reused without invoking the
 * generator again.
 */
export function ensureCodexGenerated(): Promise<EnsureCodexGeneratedResult> {
  if (activeGeneration !== undefined) {
    return activeGeneration;
  }
  activeGeneration = ensureCodexGeneratedInternal().finally(() => {
    activeGeneration = undefined;
  });
  return activeGeneration;
}

async function ensureCodexGeneratedInternal(): Promise<EnsureCodexGeneratedResult> {
  const resolved = await resolveCodexTool();
  const current = await verifyCurrentOutput(resolved);
  if (current !== undefined) {
    return { status: "reused", ...resolved, ...current };
  }

  return await withTemporaryDirectory("holycodex-generation", async (temporaryRoot) => {
    const outputDirectory = join(temporaryRoot, "typescript");
    const isolatedCodexHome = join(temporaryRoot, "codex-home");
    await mkdir(outputDirectory, { recursive: true });
    await mkdir(isolatedCodexHome, { recursive: true });
    const environment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
      CODEX_HOME: isolatedCodexHome,
    });
    await runChecked([resolved.executable, "app-server", "generate-ts", "--out", outputDirectory], {
      cwd: workspaceRoot,
      env: environment,
      maxOutputBytes: 1024 * 1024,
    });
    await rm(isolatedCodexHome, { recursive: true, force: true });
    await normalizeGeneratedText(temporaryRoot);
    await writeProtocolConstants(outputDirectory, resolved.versionNumber);
    await assertSecretFree(temporaryRoot);
    const inventory = await collectInventory(temporaryRoot);
    assertExpectedSurface(inventory);

    await rm(generatedRoot, { recursive: true, force: true });
    await cp(temporaryRoot, generatedRoot, { recursive: true, dereference: true });
    const provenance: GeneratedProvenance = {
      schema_version: "holycodex-generated-v2",
      artifact_root: "packages/codex/generated",
      codex_cli_version: resolved.codexCliVersion as `codex-cli ${string}`,
      codex_cli_digest: resolved.codexCliDigest,
      protocol_epoch: `codex-app-server-${resolved.versionNumber}`,
      generator: {
        command: ["app-server", "generate-ts"],
        supported_surface: "codex app-server generators",
      },
      typescript_root: "typescript",
      files: { count: inventory.count, digest: inventory.digest },
    };
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const verified = await verifyCurrentOutput(resolved);
    if (verified === undefined) {
      throw new Error("Generated Codex bindings failed their post-generation verification.");
    }
    return { status: "generated", ...resolved, ...verified };
  });
}

async function resolveCodexTool(): Promise<{
  readonly executable: string;
  readonly versionNumber: string;
  readonly codexCliVersion: string;
  readonly codexCliDigest: string;
}> {
  await assertMiseLatestCodexConfig();
  const expectedVersion = await resolveLatestMiseCodexVersion();
  let executable: string;
  try {
    const result = await runChecked(["mise", "which", "codex"], {
      cwd: workspaceRoot,
      env: allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS),
      maxOutputBytes: 16 * 1024,
    });
    executable = result.stdout.trim();
    if (executable.length === 0 || executable.includes("\n") || executable.includes("\r")) {
      throw new Error("mise returned an empty or ambiguous Codex executable path");
    }
    executable = await realpath(executable);
    const metadata = await lstat(executable);
    if (!metadata.isFile()) {
      throw new Error("the mise Codex launcher is not a file");
    }
  } catch (error: unknown) {
    throw new Error(`The stable Codex executable is unavailable from mise (${safeError(error)}).`);
  }

  const environment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
    CODEX_HOME: undefined,
  });
  const result = await runChecked([executable, "--version"], {
    cwd: workspaceRoot,
    env: environment,
    maxOutputBytes: 16 * 1024,
  });
  const versionOutput = result.stdout.trim();
  const match = CODEX_VERSION_OUTPUT.exec(versionOutput);
  if (match === null || match[1] === undefined) {
    throw new Error(
      `The resolved Codex tool did not report an exact stable version (received ${redactDiagnostics(versionOutput || result.stderr, environment)}).`,
    );
  }
  const versionNumber = match[1];
  assertStableVersion(versionNumber, "the Codex CLI version");
  assertLatestStableMatch(expectedVersion, versionNumber);
  return {
    executable,
    versionNumber,
    codexCliVersion: `codex-cli ${versionNumber}`,
    codexCliDigest: await sha256File(executable),
  };
}

async function assertMiseLatestCodexConfig(): Promise<void> {
  try {
    const config = await readFile(miseConfigPath, "utf8");
    if (!/^\s*codex\s*=\s*["']latest["']\s*$/mu.test(config)) {
      throw new Error('mise.toml must resolve codex from the "latest" stable channel');
    }
  } catch (error: unknown) {
    throw new Error(`The stable Codex mise channel is unavailable (${safeError(error)}).`);
  }
}

async function resolveLatestMiseCodexVersion(): Promise<string> {
  try {
    const result = await runChecked(["mise", "latest", "codex"], {
      cwd: workspaceRoot,
      env: allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS),
      maxOutputBytes: 16 * 1024,
    });
    const version = result.stdout.trim();
    assertStableVersion(version, "mise stable Codex metadata");
    return version;
  } catch (error: unknown) {
    throw new Error(
      `The stable Codex latest-channel metadata is unavailable; check network/cache access (${safeError(error)}).`,
    );
  }
}

async function verifyCurrentOutput(resolved: {
  readonly codexCliVersion: string;
  readonly codexCliDigest: string;
}): Promise<{ readonly artifactDigest: string; readonly artifactFiles: number } | undefined> {
  let provenance: GeneratedProvenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, "utf8")) as GeneratedProvenance;
  } catch {
    return undefined;
  }
  if (
    provenance.schema_version !== "holycodex-generated-v2" ||
    provenance.artifact_root !== "packages/codex/generated" ||
    !canReuseGeneratedOutput(
      {
        codexCliVersion: provenance.codex_cli_version,
        codexCliDigest: provenance.codex_cli_digest,
      },
      resolved,
    ) ||
    provenance.protocol_epoch !==
      `codex-app-server-${resolved.codexCliVersion.slice("codex-cli ".length)}` ||
    provenance.generator?.command?.join(" ") !== "app-server generate-ts" ||
    provenance.generator.supported_surface !== "codex app-server generators" ||
    provenance.typescript_root !== "typescript"
  ) {
    return undefined;
  }
  const protocolSource = await readTextIfPresent(join(generatedTypescriptRoot, "protocol.ts"));
  if (
    protocolSource !== protocolSourceForVersion(resolved.codexCliVersion.slice("codex-cli ".length))
  ) {
    return undefined;
  }
  try {
    const inventory = await collectInventory(generatedRoot);
    assertExpectedSurface(inventory);
    await assertSecretFree(generatedRoot);
    if (
      inventory.count !== provenance.files?.count ||
      inventory.digest !== provenance.files?.digest
    ) {
      return undefined;
    }
    return { artifactDigest: inventory.digest, artifactFiles: inventory.count };
  } catch {
    return undefined;
  }
}

async function writeProtocolConstants(root: string, version: string): Promise<void> {
  await writeFile(join(root, "protocol.ts"), protocolSourceForVersion(version), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function protocolSourceForVersion(version: string): string {
  return `// GENERATED CODE! DO NOT MODIFY BY HAND!\n\nexport const CODEX_PROTOCOL_VERSION = "codex-cli-${version}" as const;\nexport const CODEX_PROTOCOL_EPOCH = "codex-app-server-${version}" as const;\n`;
}

async function collectInventory(root: string): Promise<GeneratedInventory> {
  await assertNoSymlinkBoundary(root);
  const files: GeneratedFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("Generated Codex bindings may not contain symlinks.");
      }
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Generated Codex bindings contain a non-file entry.");
      }
      const relativePath = relative(root, absolute).split("\\").join("/");
      if (relativePath === "provenance.json") {
        continue;
      }
      if (!relativePath.startsWith("typescript/")) {
        throw new Error(`Generated Codex binding is outside typescript/: ${relativePath}`);
      }
      if (metadata.size <= 0 || metadata.size > MAX_FILE_BYTES) {
        throw new Error(`Generated Codex binding has an invalid size: ${relativePath}`);
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Generated Codex bindings exceed the size bound.");
      }
      files.push({
        path: relativePath,
        size: metadata.size,
        sha256: await sha256File(absolute),
      });
    }
  };
  await visit(root);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    count: files.length,
    digest: await domainSeparatedSha256("codex-schema-output", [canonicalJsonUtf8(files)]),
    files,
  };
}

function assertExpectedSurface(inventory: GeneratedInventory): void {
  const paths = new Set(inventory.files.map((file) => file.path));
  for (const required of [
    "typescript/index.ts",
    "typescript/ClientRequest.ts",
    "typescript/ClientNotification.ts",
    "typescript/ServerRequest.ts",
    "typescript/ServerNotification.ts",
    "typescript/protocol.ts",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Generated Codex bindings are missing required surface ${required}.`);
    }
  }
}

async function assertSecretFree(root: string): Promise<void> {
  const sensitiveValues = Object.entries(process.env)
    .filter(
      (entry): entry is [string, string] =>
        isSensitiveEnvironmentKey(entry[0]) && entry[1] !== undefined && entry[1].length > 0,
    )
    .map(([, value]) => value);
  if (sensitiveValues.length === 0) {
    return;
  }
  const inventory = await collectInventory(root);
  for (const file of inventory.files) {
    const content = await readFile(join(root, file.path), "utf8");
    if (sensitiveValues.some((secret) => content.includes(secret))) {
      throw new Error("Generated Codex bindings contain an environment secret value.");
    }
  }
}

async function assertNoSymlinkBoundary(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("Generated Codex bindings may not contain symlinked roots.");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function normalizeGeneratedText(root: string): Promise<void> {
  const inventory = await collectInventory(root);
  for (const file of inventory.files) {
    const path = join(root, file.path);
    const content = await readFile(path, "utf8");
    const normalized = content.replaceAll("\\r\\n", "\\n");
    if (normalized !== content) {
      await writeFile(path, normalized, { encoding: "utf8", mode: 0o600 });
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await readFile(path));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function assertStableVersion(version: string, label: string): void {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(
      `${label} must be a stable semantic version, received ${redactDiagnostics(version)}.`,
    );
  }
}

function safeError(error: unknown): string {
  return redactDiagnostics(error instanceof Error ? error.message : "unknown error");
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await ensureCodexGenerated()));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: safeError(error),
      }),
    );
    process.exitCode = 1;
  }
}
