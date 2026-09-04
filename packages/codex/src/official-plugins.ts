// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import * as Schema from "effect/Schema";

import { AppServerClient } from "./client";
import {
  checked,
  CodexError,
  failure,
  invalidData,
  isPlainObject,
  isValid,
  JsonValueSchema,
  success,
  TextSchema,
  type CodexResult,
} from "./common";
import { allowlistedEnvironment, BunStdioTransport, sanitizeDiagnostic } from "./transport";

export const OFFICIAL_CURATED_MARKETPLACE_NAME = "openai-curated" as const;
export const OFFICIAL_CURATED_MARKETPLACE_SOURCE = "https://github.com/openai/plugins.git" as const;
const OFFICIAL_CURATED_MARKETPLACE_DIRECTORY = ["plugins", "openai-plugins"] as const;
const DEFAULT_MARKETPLACE_BOOTSTRAP_TIMEOUT_MS = 30_000;
const DEFAULT_MARKETPLACE_BOOTSTRAP_POLL_INTERVAL_MS = 100;

const PluginNameSchema = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9._-]{1,63}$/u));
const PluginVersionSchema = Schema.String.pipe(
  Schema.pattern(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u),
);
const StringArraySchema = Schema.Array(Schema.String);

export const OfficialPluginIdSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u),
);
export type OfficialPluginId = typeof OfficialPluginIdSchema.Type;

export const OfficialPluginManifestSchema = Schema.Struct({
  name: PluginNameSchema,
  version: PluginVersionSchema,
  description: TextSchema,
  author: Schema.optional(JsonValueSchema),
  license: Schema.optional(TextSchema),
  homepage: Schema.optional(TextSchema),
  repository: Schema.optional(TextSchema),
  keywords: Schema.optional(StringArraySchema),
  skills: Schema.optional(StringArraySchema),
  commands: Schema.optional(StringArraySchema),
  hooks: Schema.optional(StringArraySchema),
  assets: Schema.optional(StringArraySchema),
  official: Schema.optional(Schema.Boolean),
});
export type OfficialPluginManifest = typeof OfficialPluginManifestSchema.Type;

export interface OfficialPluginVerification {
  readonly manifest: OfficialPluginManifest;
  readonly manifestPath?: string;
  readonly explicitlySelected: boolean;
}

export interface OfficialMarketplacePluginEntry {
  readonly name: string;
  readonly source: string;
}

export interface OfficialMarketplaceSnapshot {
  readonly name: typeof OFFICIAL_CURATED_MARKETPLACE_NAME;
  readonly source: typeof OFFICIAL_CURATED_MARKETPLACE_SOURCE;
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly plugins: readonly OfficialMarketplacePluginEntry[];
}

export type OfficialMarketplaceRuntimeClose = () => Promise<void>;

export interface OfficialMarketplaceBootstrapOptions {
  /** The target CODEX_HOME. It is used only for reading the reserved snapshot. */
  readonly codexHome: string;
  /** An absolute Codex executable path discovered by the caller. */
  readonly executablePath: string;
  readonly selectedPluginIds: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Test seam; production uses App Server initialize and keeps it alive while polling. */
  readonly initializeRuntime?: () => Promise<OfficialMarketplaceRuntimeClose | undefined>;
  readonly readSnapshot?: (codexHome: string) => Promise<OfficialMarketplaceSnapshot | undefined>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Set false only for callers that explicitly do not want the Git fallback. */
  readonly gitFallback?: OfficialMarketplaceGitFallbackOptions | false;
}

export interface OfficialMarketplaceGitFallbackOptions {
  readonly gitRunner?: OfficialPluginCommandRunner;
  /** Test seam for deterministic staged snapshots; production performs a shallow clone. */
  readonly cloneSnapshot?: (source: string, destination: string) => Promise<void>;
}

/**
 * Ensure the reserved provider snapshot has been populated by Codex itself.
 *
 * The openai-curated marketplace is owned by Codex. In particular, callers must never clone its
 * repository or register it with `plugin marketplace add`. A normal App Server initialize starts
 * Codex's supported marketplace sync; this function waits for that async work and only returns
 * after validating the reserved snapshot and the selected plugin entries.
 */
export async function bootstrapOfficialMarketplace(
  options: OfficialMarketplaceBootstrapOptions,
): Promise<OfficialMarketplaceSnapshot | undefined> {
  const selectedNames = selectedOfficialCuratedPluginNames(options.selectedPluginIds);
  if (selectedNames.length === 0) return undefined;
  validateBootstrapBounds(options.timeoutMs, options.pollIntervalMs);
  if (options.signal?.aborted) {
    throw new OfficialPluginAdapterError(
      "cancelled",
      "Official Codex marketplace bootstrap was cancelled.",
    );
  }
  const readSnapshot = options.readSnapshot ?? readOfficialMarketplaceSnapshot;
  const initial = await readSnapshot(options.codexHome);
  if (initial !== undefined && hasSelectedMarketplacePlugins(initial, selectedNames)) {
    return initial;
  }

  const initializeRuntime = options.initializeRuntime ?? (() => initializeOfficialRuntime(options));
  let closeRuntime: OfficialMarketplaceRuntimeClose | undefined;
  let startupFailure: OfficialPluginAdapterError | undefined;
  try {
    closeRuntime = await initializeRuntime();
  } catch (error: unknown) {
    startupFailure = marketplaceBootstrapError(
      "marketplace_unavailable",
      "Codex runtime initialization could not start the official marketplace sync. Check that Codex is available and its network/policy settings permit the official marketplace.",
      error,
    );
  }
  if (startupFailure === undefined) {
    try {
      const timeoutMs = options.timeoutMs ?? DEFAULT_MARKETPLACE_BOOTSTRAP_TIMEOUT_MS;
      const pollIntervalMs =
        options.pollIntervalMs ?? DEFAULT_MARKETPLACE_BOOTSTRAP_POLL_INTERVAL_MS;
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        if (options.signal?.aborted) {
          throw new OfficialPluginAdapterError(
            "cancelled",
            "Official Codex marketplace bootstrap was cancelled.",
          );
        }
        const latest = await readSnapshot(options.codexHome);
        if (latest !== undefined && hasSelectedMarketplacePlugins(latest, selectedNames)) {
          return latest;
        }
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        await (options.sleep ?? sleep)(Math.min(pollIntervalMs, remaining));
      }
      startupFailure = marketplaceBootstrapError(
        "marketplace_timeout",
        "The official Codex marketplace did not become ready before the bounded wait expired. Check network access and Codex marketplace policy, then retry.",
      );
    } catch (error: unknown) {
      if (error instanceof OfficialPluginAdapterError && error.code === "cancelled") {
        throw error;
      }
      startupFailure =
        error instanceof OfficialPluginAdapterError
          ? error
          : marketplaceBootstrapError(
              "marketplace_unavailable",
              "The official Codex marketplace sync failed before its bounded wait completed.",
              error,
            );
    } finally {
      await closeRuntime?.();
    }
  }
  if (options.gitFallback !== false) {
    try {
      return await provisionOfficialMarketplaceSnapshot({
        codexHome: options.codexHome,
        selectedPluginIds: options.selectedPluginIds,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.gitFallback === undefined ? {} : options.gitFallback),
      });
    } catch (error: unknown) {
      if (error instanceof OfficialPluginAdapterError) throw error;
      throw marketplaceBootstrapError(
        "marketplace_unavailable",
        `The official marketplace could not be populated after runtime startup (${startupFailure?.code ?? "unavailable"}). Check network access and retry.`,
        error,
      );
    }
  }
  throw (
    startupFailure ??
    marketplaceBootstrapError(
      "marketplace_timeout",
      "The official Codex marketplace did not become ready before the bounded wait expired.",
    )
  );
}

export interface OfficialMarketplaceProvisionOptions {
  readonly codexHome: string;
  readonly selectedPluginIds: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly gitRunner?: OfficialPluginCommandRunner;
  /** Test seam for a deterministic staged snapshot; production uses git clone. */
  readonly cloneSnapshot?: (source: string, destination: string) => Promise<void>;
}

/**
 * Fetch and publish the canonical official snapshot when Codex startup did not provide it. This is
 * deliberately a separate fallback boundary: it never invokes `plugin marketplace add` and never
 * writes Codex configuration.
 */
export async function provisionOfficialMarketplaceSnapshot(
  options: OfficialMarketplaceProvisionOptions,
): Promise<OfficialMarketplaceSnapshot> {
  const selectedNames = selectedOfficialCuratedPluginNames(options.selectedPluginIds);
  if (selectedNames.length === 0) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace fallback requires at least one selected provider plugin.",
    );
  }
  validateBootstrapBounds(options.timeoutMs, undefined);
  if (!isAbsolute(options.codexHome)) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The Codex home for official marketplace fallback must be absolute.",
    );
  }
  if (options.signal?.aborted) {
    throw new OfficialPluginAdapterError(
      "cancelled",
      "Official Codex marketplace fallback was cancelled.",
    );
  }
  const environment = allowlistedEnvironment(options.environment);
  const gitRunner =
    options.gitRunner ??
    createNodeBunOfficialPluginCommandRunner("git", {
      environment,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_MARKETPLACE_BOOTSTRAP_TIMEOUT_MS;
  let remoteHead: string;
  try {
    remoteHead = await resolveOfficialMarketplaceHead(gitRunner, timeoutMs, options.signal);
  } catch (error: unknown) {
    if (error instanceof OfficialPluginAdapterError) throw error;
    throw marketplaceBootstrapError(
      "marketplace_unavailable",
      "The official Codex marketplace remote HEAD could not be resolved. Check network access and retry.",
      error,
    );
  }
  const pluginsParent = join(options.codexHome, "plugins");
  const targetRoot = join(pluginsParent, OFFICIAL_CURATED_MARKETPLACE_DIRECTORY[1]);
  await ensureFallbackParent(pluginsParent, options.codexHome);
  const existing = await lstat(targetRoot).catch((error: unknown) => {
    if (isFileMissing(error)) return undefined;
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The reserved official marketplace path could not be inspected safely.",
      error,
    );
  });
  if (existing !== undefined) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The reserved official marketplace path appeared during bootstrap; refusing to overwrite it.",
    );
  }
  const stagingRoot = await mkdtemp(join(pluginsParent, ".openai-plugins-stage-"));
  try {
    await assertReservedPathHasNoSymlink(options.codexHome, stagingRoot);
    if (options.cloneSnapshot !== undefined) {
      await options.cloneSnapshot(OFFICIAL_CURATED_MARKETPLACE_SOURCE, stagingRoot);
    } else {
      const result = await gitRunner.run(
        ["clone", "--depth=1", "--no-tags", OFFICIAL_CURATED_MARKETPLACE_SOURCE, stagingRoot],
        { ...(options.signal === undefined ? {} : { signal: options.signal }), timeoutMs },
      );
      if (result.exitCode !== 0) {
        throw marketplaceBootstrapError(
          "marketplace_unavailable",
          "The official Codex marketplace could not be downloaded. Check network access and retry.",
          result.stderr,
        );
      }
    }
    await assertNoSymlinkTree(stagingRoot);
    const stagedSnapshot = await readOfficialMarketplaceSnapshotAtRoot(
      stagingRoot,
      options.codexHome,
    );
    if (
      stagedSnapshot === undefined ||
      !hasSelectedMarketplacePlugins(stagedSnapshot, selectedNames)
    ) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The downloaded official marketplace is missing the selected plugin entries or manifest.",
      );
    }
    const checkedOutHead = await readCheckedOutHead(
      gitRunner,
      stagingRoot,
      timeoutMs,
      options.signal,
    );
    if (checkedOutHead !== remoteHead) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The downloaded official marketplace did not match the verified remote HEAD.",
      );
    }
    const collision = await lstat(targetRoot).catch((error: unknown) => {
      if (isFileMissing(error)) return undefined;
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The reserved official marketplace path could not be checked before publication.",
        error,
      );
    });
    if (collision !== undefined) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The reserved official marketplace path appeared during staging; refusing to overwrite it.",
      );
    }
    await rename(stagingRoot, targetRoot);
    const published = await readOfficialMarketplaceSnapshot(options.codexHome);
    if (published === undefined || !hasSelectedMarketplacePlugins(published, selectedNames)) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The published official marketplace failed validation.",
      );
    }
    return published;
  } catch (error: unknown) {
    if (error instanceof OfficialPluginAdapterError) throw error;
    throw marketplaceBootstrapError(
      "marketplace_unavailable",
      "The official Codex marketplace fallback failed safely. Check network access and retry.",
      error,
    );
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function resolveOfficialMarketplaceHead(
  gitRunner: OfficialPluginCommandRunner,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await gitRunner.run(["ls-remote", OFFICIAL_CURATED_MARKETPLACE_SOURCE, "HEAD"], {
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw marketplaceBootstrapError(
      "marketplace_unavailable",
      "The official Codex marketplace remote HEAD could not be resolved. Check network access and retry.",
      result.stderr,
    );
  }
  const lines = result.stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const match =
    lines.length === 1 ? /^([0-9a-f]{40}|[0-9a-f]{64})\s+HEAD$/iu.exec(lines[0] ?? "") : null;
  if (match?.[1] === undefined) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official Codex marketplace remote HEAD response was malformed.",
    );
  }
  return match[1].toLowerCase();
}

async function readCheckedOutHead(
  gitRunner: OfficialPluginCommandRunner,
  stagingRoot: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await gitRunner.run(["rev-parse", "HEAD"], {
    timeoutMs,
    cwd: stagingRoot,
    ...(signal === undefined ? {} : { signal }),
  });
  const head = result.stdout.trim().toLowerCase();
  if (result.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The downloaded official marketplace checkout did not expose a valid HEAD.",
      result.stderr,
    );
  }
  return head;
}

async function ensureFallbackParent(parent: string, codexHome: string): Promise<void> {
  await assertNoSymlinkAncestors(codexHome, parent);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkAncestors(codexHome, parent);
}

async function assertNoSymlinkAncestors(root: string, target: string): Promise<void> {
  const rootPath = resolve(root);
  let current = resolve(target);
  while (true) {
    const entry = await lstat(current).catch((error: unknown) => {
      if (isFileMissing(error)) return undefined;
      throw error;
    });
    if (entry?.isSymbolicLink()) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace path cannot contain symlinks.",
      );
    }
    if (current === rootPath) return;
    const parent = dirname(current);
    if (parent === current || (parent !== rootPath && !pathIsWithin(rootPath, parent))) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace path escaped CODEX_HOME.",
      );
    }
    current = parent;
  }
}

function pathIsWithin(root: string, child: string): boolean {
  const remainder = relative(root, child);
  return (
    remainder.length > 0 &&
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

async function assertNoSymlinkTree(root: string): Promise<void> {
  const entry = await lstat(root);
  if (entry.isSymbolicLink()) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace snapshot cannot contain symlinks.",
    );
  }
  if (!entry.isDirectory()) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace snapshot is not a directory.",
    );
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const child of entries) {
    const path = join(root, child.name);
    const childEntry = await lstat(path);
    if (childEntry.isSymbolicLink()) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace snapshot cannot contain symlinks.",
      );
    }
    if (childEntry.isDirectory()) await assertNoSymlinkTree(path);
  }
}

export async function readOfficialMarketplaceSnapshot(
  codexHome: string,
): Promise<OfficialMarketplaceSnapshot | undefined> {
  return await readOfficialMarketplaceSnapshotAtRoot(
    join(codexHome, ...OFFICIAL_CURATED_MARKETPLACE_DIRECTORY),
    codexHome,
  );
}

async function readOfficialMarketplaceSnapshotAtRoot(
  rootPath: string,
  codexHome: string | undefined,
): Promise<OfficialMarketplaceSnapshot | undefined> {
  // Validate the complete reserved path before checking the leaf.  When the
  // leaf is absent, a symlinked ancestor would otherwise be treated as a
  // normal "not populated yet" state and App Server startup could populate
  // content outside CODEX_HOME.
  if (codexHome !== undefined) {
    await assertNoSymlinkAncestors(codexHome, rootPath);
  }
  const rootEntry = await lstat(rootPath).catch((error: unknown) => {
    if (isFileMissing(error)) return undefined;
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The reserved openai-curated marketplace path could not be read safely.",
      error,
    );
  });
  if (rootEntry === undefined) return undefined;
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The reserved openai-curated marketplace path is not a real directory.",
    );
  }
  if (codexHome !== undefined) {
    await assertReservedPathHasNoSymlink(codexHome, rootPath);
  } else {
    await assertNoSymlinkTree(rootPath);
  }
  if (codexHome !== undefined) await assertNoSymlinkTree(rootPath);
  const root = await realpath(rootPath);
  const candidates = [
    join(root, ".agents", "plugins", "marketplace.json"),
    join(root, ".codex-plugin", "marketplace.json"),
    join(root, "marketplace.json"),
  ];
  let manifestPath: string | undefined;
  let contents: string | undefined;
  for (const candidate of candidates) {
    const entry = await lstat(candidate).catch((error: unknown) => {
      if (isFileMissing(error)) return undefined;
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace manifest could not be read safely.",
        error,
      );
    });
    if (entry === undefined) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace manifest is not a regular file.",
      );
    }
    await assertReservedPathHasNoSymlink(root, candidate);
    if (manifestPath !== undefined) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The reserved official marketplace contains more than one manifest.",
      );
    }
    manifestPath = candidate;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(candidate));
    } catch (error: unknown) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace manifest is not valid UTF-8.",
        error,
      );
    }
  }
  if (manifestPath === undefined || contents === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace manifest is not valid JSON.",
      error,
    );
  }
  return parseOfficialMarketplaceSnapshot(parsed, root, manifestPath);
}

export function parseOfficialMarketplaceSnapshot(
  input: unknown,
  rootPath = `${OFFICIAL_CURATED_MARKETPLACE_DIRECTORY.join("/")}`,
  manifestPath = `${rootPath}/marketplace.json`,
): OfficialMarketplaceSnapshot {
  if (!isPlainObject(input) || input["name"] !== OFFICIAL_CURATED_MARKETPLACE_NAME) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The reserved official marketplace manifest has an unexpected name.",
    );
  }
  validateOfficialMarketplaceSource(input);
  const rawPlugins = input["plugins"];
  if (!Array.isArray(rawPlugins) || rawPlugins.length === 0) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace manifest has no plugin entries.",
    );
  }
  const plugins: OfficialMarketplacePluginEntry[] = [];
  const names = new Set<string>();
  for (const rawPlugin of rawPlugins) {
    if (!isPlainObject(rawPlugin) || typeof rawPlugin["name"] !== "string") {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace contains a malformed plugin entry.",
      );
    }
    const name = rawPlugin["name"];
    if (!/^[a-z][a-z0-9._-]{1,63}$/u.test(name) || names.has(name)) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace contains a duplicate or invalid plugin name.",
      );
    }
    const source = marketplacePluginSource(rawPlugin);
    if (!isSafeMarketplaceRelativePath(source)) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        `The official marketplace source for ${name} is unsafe.`,
      );
    }
    names.add(name);
    plugins.push({ name, source });
  }
  return {
    name: OFFICIAL_CURATED_MARKETPLACE_NAME,
    source: OFFICIAL_CURATED_MARKETPLACE_SOURCE,
    rootPath,
    manifestPath,
    plugins,
  };
}

function validateOfficialMarketplaceSource(input: Record<string, unknown>): void {
  for (const key of ["source", "repository", "repo", "url"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const source =
      typeof value === "string"
        ? value
        : isPlainObject(value) && typeof value["url"] === "string"
          ? value["url"]
          : undefined;
    if (source !== OFFICIAL_CURATED_MARKETPLACE_SOURCE) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The reserved official marketplace source is not the approved OpenAI repository.",
      );
    }
  }
}

function marketplacePluginSource(input: Record<string, unknown>): string | undefined {
  const source = input["source"];
  if (typeof source === "string") return source;
  if (isPlainObject(source) && typeof source["path"] === "string") return source["path"];
  if (typeof input["path"] === "string") return input["path"];
  return undefined;
}

function isSafeMarketplaceRelativePath(value: string | undefined): value is string {
  if (value === undefined || value.length === 0 || isAbsolute(value)) return false;
  if (/^[A-Za-z]:[\\/]/u.test(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)) return false;
  return normalized
    .split("/")
    .every((segment) => segment.length === 0 || segment === "." || segment !== "..");
}

function selectedOfficialCuratedPluginNames(
  selectedPluginIds: readonly string[],
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const pluginId of selectedPluginIds) {
    const separator = pluginId.lastIndexOf("@");
    if (separator < 1) continue;
    const marketplace = pluginId.slice(separator + 1);
    if (marketplace !== OFFICIAL_CURATED_MARKETPLACE_NAME) continue;
    const name = pluginId.slice(0, separator);
    if (!/^[a-z][a-z0-9._-]{1,63}$/u.test(name)) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "A selected official marketplace plugin id is invalid.",
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function hasSelectedMarketplacePlugins(
  snapshot: OfficialMarketplaceSnapshot,
  selectedNames: readonly string[],
): boolean {
  return selectedNames.every((name) => {
    const plugin = snapshot.plugins.find((candidate) => candidate.name === name);
    if (plugin === undefined) return false;
    const normalized = plugin.source.replaceAll("\\", "/").replace(/\/+$/u, "");
    return normalized.split("/").at(-1) === name;
  });
}

async function initializeOfficialRuntime(
  options: OfficialMarketplaceBootstrapOptions,
): Promise<OfficialMarketplaceRuntimeClose> {
  const environment = allowlistedEnvironment(options.environment);
  let transport: BunStdioTransport | undefined;
  try {
    transport = new BunStdioTransport({
      executablePath: options.executablePath,
      environment,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const client = new AppServerClient(transport, {
      requestTimeoutMs: Math.min(
        options.timeoutMs ?? DEFAULT_MARKETPLACE_BOOTSTRAP_TIMEOUT_MS,
        10_000,
      ),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await client.initialize();
    return async () => {
      await client.close();
    };
  } catch (error: unknown) {
    await transport?.close().catch(() => undefined);
    throw error;
  }
}

function validateBootstrapBounds(
  timeoutMs: number | undefined,
  pollIntervalMs: number | undefined,
) {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000)
  ) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace timeout is invalid.",
    );
  }
  if (
    pollIntervalMs !== undefined &&
    (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000)
  ) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace poll interval is invalid.",
    );
  }
}

async function assertReservedPathHasNoSymlink(codexHome: string, rootPath: string): Promise<void> {
  const home = await realpath(codexHome);
  const root = await realpath(rootPath);
  const remainder = relative(home, root);
  if (remainder === "" || remainder === ".." || remainder.startsWith(`..${sep}`)) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The reserved official marketplace is outside CODEX_HOME.",
    );
  }
  const homePath = resolve(codexHome);
  let current = resolve(rootPath);
  while (true) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The reserved official marketplace path cannot contain symlinks.",
      );
    }
    if (current === homePath) break;
    const parent = dirname(current);
    if (parent === current) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The reserved official marketplace path is outside CODEX_HOME.",
      );
    }
    current = parent;
  }
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function marketplaceBootstrapError(
  code: "marketplace_invalid" | "marketplace_timeout" | "marketplace_unavailable",
  message: string,
  cause?: unknown,
): OfficialPluginAdapterError {
  return new OfficialPluginAdapterError(
    code,
    message,
    cause instanceof Error ? { cause: sanitizeDiagnostic(cause.message) } : {},
  );
}

function containsMcpDeclaration(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsMcpDeclaration(item));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/mcp|model[._-]?context[._-]?protocol/iu.test(key)) {
      return true;
    }
    if (containsMcpDeclaration(item)) {
      return true;
    }
  }
  return false;
}

export function parseOfficialPluginManifest(input: unknown): CodexResult<OfficialPluginManifest> {
  if (containsMcpDeclaration(input)) {
    return failure(
      new CodexError("manifest_invalid", "HolyCodex-owned plugin payloads cannot declare MCP."),
    );
  }
  if (!isValid(OfficialPluginManifestSchema, input)) {
    return failure(invalidData("official plugin manifest", input));
  }
  return success(checked(OfficialPluginManifestSchema, input, "official plugin manifest"));
}

export function verifyOfficialPluginManifest(input: unknown): OfficialPluginVerification {
  const parsed = parseOfficialPluginManifest(input);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return { manifest: parsed.value, explicitlySelected: false };
}

export async function verifyOfficialPluginManifestFile(
  pluginRoot: string,
): Promise<OfficialPluginVerification> {
  let root: string;
  try {
    root = await realpath(pluginRoot);
    if (!(await stat(root)).isDirectory()) {
      throw new Error("plugin root is not a directory");
    }
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The official plugin root is invalid.",
      {},
      { cause: error },
    );
  }
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  let contents: string;
  try {
    const manifestEntry = await lstat(manifestPath);
    if (manifestEntry.isSymbolicLink() || !manifestEntry.isFile()) {
      throw new Error("plugin manifest is not a regular file");
    }
    contents = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(manifestPath));
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The plugin is missing .codex-plugin/plugin.json.",
      {},
      { cause: error },
    );
  }
  let parsedJson: unknown;
  try {
    // JSON.parse is immediately validated by the manifest schema and MCP-key scan.
    parsedJson = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The plugin manifest is not valid JSON.",
      {},
      { cause: error },
    );
  }
  const verification = verifyOfficialPluginManifest(parsedJson);
  return { ...verification, manifestPath };
}

export const OfficialPluginSelectionSchema = Schema.Struct({
  id: PluginNameSchema,
  selected: Schema.Literal(true),
});
export type OfficialPluginSelection = typeof OfficialPluginSelectionSchema.Type;

export function selectOfficialPlugins(
  available: readonly OfficialPluginManifest[],
  selections: readonly OfficialPluginSelection[],
): readonly OfficialPluginVerification[] {
  const byName = new Map(available.map((manifest) => [manifest.name, manifest]));
  const output: OfficialPluginVerification[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const parsedSelection = checked(
      OfficialPluginSelectionSchema,
      selection,
      "official plugin selection",
    );
    if (seen.has(parsedSelection.id)) {
      throw new CodexError("manifest_invalid", "An official plugin was selected more than once.", {
        id: parsedSelection.id,
      });
    }
    const manifest = byName.get(parsedSelection.id);
    if (!manifest) {
      throw new CodexError(
        "manifest_invalid",
        "An explicitly selected official plugin is unavailable.",
        {
          id: parsedSelection.id,
        },
      );
    }
    seen.add(parsedSelection.id);
    output.push({ manifest, explicitlySelected: true });
  }
  return output;
}

export const LiveOfficialPluginEntrySchema = Schema.Struct(
  {
    pluginId: OfficialPluginIdSchema,
    installed: Schema.Boolean,
    enabled: Schema.Boolean,
    name: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
    marketplaceName: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
    version: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);
export type LiveOfficialPluginEntry = typeof LiveOfficialPluginEntrySchema.Type;

export const LiveOfficialPluginListEnvelopeSchema = Schema.Struct({
  installed: Schema.Array(LiveOfficialPluginEntrySchema),
  available: Schema.Array(LiveOfficialPluginEntrySchema),
});
export type LiveOfficialPluginListEnvelope = typeof LiveOfficialPluginListEnvelopeSchema.Type;

export function parseLiveOfficialPluginList(
  input: unknown,
): CodexResult<LiveOfficialPluginListEnvelope> {
  if (!isValid(LiveOfficialPluginListEnvelopeSchema, input)) {
    return failure(invalidData("live official plugin list", input));
  }
  return success(checked(LiveOfficialPluginListEnvelopeSchema, input, "live official plugin list"));
}

export interface OfficialPluginCommandRunner {
  readonly run: (
    args: readonly string[],
    options?: Readonly<{
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly cwd?: string;
    }>,
  ) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
}

export interface OfficialPluginAdapterOptions {
  readonly executable: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly codexHome?: string;
  readonly officialMarketplaceFallback?: OfficialMarketplaceGitFallbackOptions | false;
  readonly runner?: OfficialPluginCommandRunner;
  readonly timeoutMs?: number;
  readonly stdoutLimit?: number;
  readonly stderrLimit?: number;
}

export interface OfficialPluginAdapter {
  readonly list: () => Promise<LiveOfficialPluginListEnvelope>;
  readonly ensureOfficialMarketplace: (selectedPluginIds: readonly string[]) => Promise<void>;
  readonly addMarketplace: (source: string, signal?: AbortSignal) => Promise<void>;
  readonly add: (pluginId: string, signal?: AbortSignal) => Promise<void>;
  readonly remove: (pluginId: string, signal?: AbortSignal) => Promise<void>;
}

export class OfficialPluginAdapterError extends Error {
  readonly code:
    | "command_failed"
    | "timeout"
    | "output_limit"
    | "cancelled"
    | "readback_mismatch"
    | "plugin_disabled"
    | "plugin_missing"
    | "marketplace_invalid"
    | "marketplace_timeout"
    | "marketplace_unavailable";
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: OfficialPluginAdapterError["code"],
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "OfficialPluginAdapterError";
    this.code = code;
    this.details = details;
  }
}

export function createOfficialPluginAdapter(
  options: OfficialPluginAdapterOptions,
): OfficialPluginAdapter {
  const runner =
    options.runner ??
    createNodeBunOfficialPluginCommandRunner(options.executable, {
      environment: options.environment ?? allowlistedEnvironment(),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.stdoutLimit === undefined ? {} : { stdoutLimit: options.stdoutLimit }),
      ...(options.stderrLimit === undefined ? {} : { stderrLimit: options.stderrLimit }),
    });
  const list = async (): Promise<LiveOfficialPluginListEnvelope> => {
    const result = await runner.run(["plugin", "list", "--json"]);
    if (result.exitCode !== 0) {
      throw commandError("list", result);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new OfficialPluginAdapterError("command_failed", "Codex returned invalid plugin data.");
    }
    const decoded = parseLiveOfficialPluginList(parsed);
    if (!decoded.ok) {
      throw new OfficialPluginAdapterError(
        "command_failed",
        "Codex returned an invalid official plugin list.",
      );
    }
    return decoded.value;
  };
  return {
    list,
    ensureOfficialMarketplace: async (selectedPluginIds) => {
      if (options.codexHome === undefined) {
        throw new OfficialPluginAdapterError(
          "marketplace_unavailable",
          "Codex home is unavailable; the official marketplace cannot be bootstrapped safely.",
        );
      }
      await bootstrapOfficialMarketplace({
        codexHome: options.codexHome,
        executablePath: options.executable,
        selectedPluginIds,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.officialMarketplaceFallback === undefined
          ? {}
          : { gitFallback: options.officialMarketplaceFallback }),
      });
    },
    addMarketplace: async (source, signal) => {
      const checkedSource = checked(OfficialPluginIdSchema, source, "plugin marketplace source");
      if (
        checkedSource === OFFICIAL_CURATED_MARKETPLACE_NAME ||
        checkedSource === OFFICIAL_CURATED_MARKETPLACE_SOURCE
      ) {
        throw new OfficialPluginAdapterError(
          "marketplace_invalid",
          "The reserved openai-curated marketplace must be populated by Codex runtime startup; it cannot be added manually.",
        );
      }
      const result = await runner.run(
        ["plugin", "marketplace", "add", checkedSource],
        signal === undefined ? undefined : { signal },
      );
      if (result.exitCode !== 0 && !/already (?:exists|added)/iu.test(result.stderr)) {
        throw commandError("marketplace add", result, checkedSource);
      }
    },
    add: async (pluginId, signal) => {
      const checkedPluginId = checked(OfficialPluginIdSchema, pluginId, "official plugin id");
      const result = await runner.run(
        ["plugin", "add", checkedPluginId, "--json"],
        signal === undefined ? undefined : { signal },
      );
      if (result.exitCode !== 0) {
        throw commandError("add", result, checkedPluginId);
      }
      const live = await list();
      const entries = [...live.installed, ...live.available].filter(
        (entry) => entry.pluginId === checkedPluginId,
      );
      const entry = entries.find((candidate) => candidate.installed) ?? entries[0];
      if (!entry) {
        throw new OfficialPluginAdapterError(
          "readback_mismatch",
          `Codex did not report ${checkedPluginId} after installation.`,
          { plugin_id: checkedPluginId },
        );
      }
      if (!entry.installed) {
        throw new OfficialPluginAdapterError(
          "plugin_missing",
          `Codex reported ${checkedPluginId} as unavailable after installation.`,
          { plugin_id: checkedPluginId },
        );
      }
      if (!entry.enabled) {
        throw new OfficialPluginAdapterError(
          "plugin_disabled",
          `Codex installed ${checkedPluginId} but it is disabled; enable it in Codex and retry.`,
          { plugin_id: checkedPluginId },
        );
      }
    },
    remove: async (pluginId, signal) => {
      const checkedPluginId = checked(OfficialPluginIdSchema, pluginId, "official plugin id");
      const result = await runner.run(
        ["plugin", "remove", checkedPluginId, "--json"],
        signal === undefined ? undefined : { signal },
      );
      if (result.exitCode !== 0 && !/not (?:installed|found)|missing/iu.test(result.stderr)) {
        throw commandError("remove", result, checkedPluginId);
      }
      const live = await list();
      const entry = [...live.installed, ...live.available].find(
        (candidate) => candidate.pluginId === checkedPluginId && candidate.installed,
      );
      if (entry !== undefined) {
        throw new OfficialPluginAdapterError(
          "readback_mismatch",
          `Codex still reports ${checkedPluginId} after removal.`,
          { plugin_id: checkedPluginId },
        );
      }
    },
  };
}

function commandError(
  operation: "list" | "add" | "remove" | "marketplace add",
  result: Readonly<{ exitCode: number; stdout: string; stderr: string }>,
  pluginId?: string,
): OfficialPluginAdapterError {
  const diagnostics = sanitizeDiagnostic(result.stderr).trim().slice(0, 512);
  const suffix = diagnostics.length > 0 ? `: ${diagnostics}` : "";
  return new OfficialPluginAdapterError(
    "command_failed",
    `Codex plugin ${operation} failed${pluginId === undefined ? "" : ` for ${pluginId}`}${suffix}`,
    { exit_code: result.exitCode },
  );
}

function createNodeBunOfficialPluginCommandRunner(
  executable: string,
  options: Readonly<{
    readonly environment?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly stdoutLimit?: number;
    readonly stderrLimit?: number;
  }>,
): OfficialPluginCommandRunner {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stdoutLimit = options.stdoutLimit ?? 128 * 1024;
  const stderrLimit = options.stderrLimit ?? 16 * 1024;
  return {
    run: (args, runOptions) =>
      runNodeBunCommand(executable, args, {
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        timeoutMs: runOptions?.timeoutMs ?? timeoutMs,
        stdoutLimit,
        stderrLimit,
        ...(runOptions?.cwd === undefined ? {} : { cwd: runOptions.cwd }),
        ...(runOptions?.signal === undefined ? {} : { signal: runOptions.signal }),
      }),
  };
}

async function runNodeBunCommand(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    readonly environment?: Readonly<Record<string, string>>;
    readonly cwd?: string;
    readonly timeoutMs: number;
    readonly stdoutLimit: number;
    readonly stderrLimit: number;
    readonly signal?: AbortSignal;
  }>,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  if (options.signal?.aborted) {
    throw new OfficialPluginAdapterError("cancelled", "The Codex plugin command was cancelled.");
  }
  const child = spawn(executable, [...args], {
    env: options.environment === undefined ? undefined : { ...options.environment },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = collectChildStream(child.stdout, options.stdoutLimit);
  const stderr = collectChildStream(child.stderr, options.stderrLimit);
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    abortHandler = () => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      reject(
        new OfficialPluginAdapterError("cancelled", "The Codex plugin command was cancelled."),
      );
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      reject(new OfficialPluginAdapterError("timeout", "The Codex plugin command timed out."));
    }, options.timeoutMs);
  });
  try {
    const [stdoutText, stderrText, exitCode] = await Promise.race([
      Promise.all([stdout, stderr, exit]),
      cancellation,
      timeout,
    ]);
    return { stdout: stdoutText, stderr: stderrText, exitCode };
  } catch (error: unknown) {
    try {
      child.kill();
    } catch {
      // The process may already be gone.
    }
    if (error instanceof OfficialPluginAdapterError) throw error;
    throw new OfficialPluginAdapterError("command_failed", "The Codex plugin command failed.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler !== undefined) options.signal?.removeEventListener("abort", abortHandler);
  }
}

function collectChildStream(stream: NodeJS.ReadableStream | null, limit: number): Promise<string> {
  if (stream === null) {
    return Promise.reject(
      new OfficialPluginAdapterError(
        "command_failed",
        "Codex plugin command output is unavailable.",
      ),
    );
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    stream.on("data", (chunk: unknown) => {
      const bytes =
        typeof chunk === "string"
          ? new TextEncoder().encode(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : undefined;
      if (bytes === undefined) {
        reject(
          new OfficialPluginAdapterError("command_failed", "Codex plugin output was invalid."),
        );
        return;
      }
      size += bytes.byteLength;
      if (size > limit) {
        reject(
          new OfficialPluginAdapterError("output_limit", "Codex plugin output exceeded its limit."),
        );
        return;
      }
      chunks.push(bytes);
    });
    stream.once("end", () => {
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(output));
      } catch (error: unknown) {
        reject(error);
      }
    });
    stream.once("error", (error: unknown) => reject(error));
  });
}
