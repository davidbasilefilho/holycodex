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

import {
  canonicalOfficialPluginId,
  OFFICIAL_OPENAI_CURATED_PLUGIN_NAMES,
  officialPluginIdCandidates,
  resolveOfficialPluginIdentity,
  type OfficialPluginIdentity,
} from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
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

/** Canonical official curated marketplace name used by the Codex integration. */
export const OFFICIAL_CURATED_MARKETPLACE_NAME = "openai-curated" as const;
/** Canonical official curated marketplace source used by the Codex integration. */
export const OFFICIAL_CURATED_MARKETPLACE_SOURCE = "https://github.com/openai/plugins.git" as const;
const HOLYCODEX_MARKETPLACE_NAME = "holycodex";
const HOLYCODEX_MARKETPLACE_SOURCE = "davidbasilefilho/holycodex";
const HOLYCODEX_MARKETPLACE_GIT_SOURCES = [
  HOLYCODEX_MARKETPLACE_SOURCE,
  "https://github.com/davidbasilefilho/holycodex.git",
  "https://github.com/davidbasilefilho/holycodex",
  "https://github.com/davidbasilefilho/holycodex.git/",
  "https://github.com/davidbasilefilho/holycodex/",
  "git@github.com:davidbasilefilho/holycodex.git",
  "git@github.com:davidbasilefilho/holycodex",
  "ssh://git@github.com/davidbasilefilho/holycodex.git",
  "ssh://git@github.com/davidbasilefilho/holycodex",
] as const;
const OFFICIAL_CURATED_MARKETPLACE_DIRECTORY = ["plugins", "openai-plugins"] as const;
const DEFAULT_MARKETPLACE_BOOTSTRAP_TIMEOUT_MS = 30_000;
const DEFAULT_MARKETPLACE_BOOTSTRAP_POLL_INTERVAL_MS = 100;
const WINDOWS_SNAPSHOT_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;

const PluginNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{1,63}$/u));
const MarketplaceSourceSchema = Schema.Union([
  Schema.String,
  Schema.StructWithRest(Schema.Struct({ url: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
]);
const ApprovedMarketplaceSourceSchema = Schema.Union([
  Schema.Literals([OFFICIAL_CURATED_MARKETPLACE_SOURCE]),
  Schema.StructWithRest(
    Schema.Struct({ url: Schema.Literals([OFFICIAL_CURATED_MARKETPLACE_SOURCE]) }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
]);
const MarketplaceManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.Literals([OFFICIAL_CURATED_MARKETPLACE_NAME]),
    plugins: Schema.Array(Schema.Unknown),
    source: Schema.optional(MarketplaceSourceSchema),
    repository: Schema.optional(MarketplaceSourceSchema),
    repo: Schema.optional(MarketplaceSourceSchema),
    url: Schema.optional(MarketplaceSourceSchema),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const SafeMarketplacePathSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.length === 0 || isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) return false;
    const normalized = value.replaceAll("\\", "/");
    return (
      !normalized.startsWith("/") &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized) &&
      normalized
        .split("/")
        .every((segment) => segment.length === 0 || segment === "." || segment !== "..")
    );
  }),
);
const MarketplacePluginSourceSchema = Schema.Union([
  Schema.String,
  Schema.StructWithRest(Schema.Struct({ path: Schema.optional(Schema.String) }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
]);
const MarketplacePluginSchema = Schema.StructWithRest(
  Schema.Struct({
    name: PluginNameSchema,
    source: Schema.optional(MarketplacePluginSourceSchema),
    path: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const PluginVersionSchema = Schema.String.check(
  Schema.isPattern(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u),
);
const StringArraySchema = Schema.Array(Schema.String);

/** Validates official plugin id values at the Codex boundary. */
export const OfficialPluginIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u),
);
/** Type of official plugin id values. */
export type OfficialPluginId = typeof OfficialPluginIdSchema.Type;

/** Validates official plugin manifest values at the Codex boundary. */
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
/** Type of official plugin manifest values. */
export type OfficialPluginManifest = typeof OfficialPluginManifestSchema.Type;

/** Data contract for official plugin verification. */
export interface OfficialPluginVerification {
  /** Manifest in the official plugin verification contract. */
  readonly manifest: OfficialPluginManifest;
  /** Manifest path in the official plugin verification contract. */
  readonly manifestPath?: string;
  /** Explicitly selected in the official plugin verification contract. */
  readonly explicitlySelected: boolean;
}

/** Data contract for official marketplace plugin entry. */
export interface OfficialMarketplacePluginEntry {
  /** Human-readable name of the entity. */
  readonly name: string;
  /** Source in the official marketplace plugin entry contract. */
  readonly source: string;
}

/** Data contract for official marketplace snapshot. */
export interface OfficialMarketplaceSnapshot {
  /** Human-readable name of the entity. */
  readonly name: typeof OFFICIAL_CURATED_MARKETPLACE_NAME;
  /** Source in the official marketplace snapshot contract. */
  readonly source: typeof OFFICIAL_CURATED_MARKETPLACE_SOURCE;
  /** Root path in the official marketplace snapshot contract. */
  readonly rootPath: string;
  /** Manifest path in the official marketplace snapshot contract. */
  readonly manifestPath: string;
  /** Plugins in the official marketplace snapshot contract. */
  readonly plugins: readonly OfficialMarketplacePluginEntry[];
}

/** Type of official marketplace runtime close values. */
export type OfficialMarketplaceRuntimeClose = () => Promise<void>;

/** Options for configuring official marketplace bootstrap. */
export interface OfficialMarketplaceBootstrapOptions {
  /** The target CODEX_HOME. It is used only for reading the reserved snapshot. */
  readonly codexHome: string;
  /** An absolute Codex executable path discovered by the caller. */
  readonly executablePath: string;
  /** Selected plugin ids in the official marketplace bootstrap options contract. */
  readonly selectedPluginIds: readonly string[];
  /** Environment variables passed to the process. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Signal in the official marketplace bootstrap options contract. */
  readonly signal?: AbortSignal;
  /** Timeout ms in the official marketplace bootstrap options contract. */
  readonly timeoutMs?: number;
  /** Poll interval ms in the official marketplace bootstrap options contract. */
  readonly pollIntervalMs?: number;
  /** Test seam; production uses App Server initialize and keeps it alive while polling. */
  readonly initializeRuntime?: () => Promise<OfficialMarketplaceRuntimeClose | undefined>;
  /** Read snapshot in the official marketplace bootstrap options contract. */
  readonly readSnapshot?: (codexHome: string) => Promise<OfficialMarketplaceSnapshot | undefined>;
  /** Sleep in the official marketplace bootstrap options contract. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Set false only for callers that explicitly do not want the Git fallback. */
  readonly gitFallback?: OfficialMarketplaceGitFallbackOptions | false;
}

/** Options for configuring official marketplace git fallback. */
export interface OfficialMarketplaceGitFallbackOptions {
  /** Git runner in the official marketplace git fallback options contract. */
  readonly gitRunner?: OfficialPluginCommandRunner;
  /** Test seam for deterministic staged snapshots; production performs a shallow clone. */
  readonly cloneSnapshot?: (source: string, destination: string) => Promise<void>;
}

/**
 * Populate and validate the reserved OpenAI provider snapshot in CODEX_HOME. App Server startup
 * gets the first opportunity to populate Codex's cache; when it does not, the official Git source
 * is staged at Codex's reserved snapshot path and validated before publication. This snapshot is
 * separate from the configurable marketplace catalog used by the CLI plugin commands.
 */
export function bootstrapOfficialMarketplace(
  options: OfficialMarketplaceBootstrapOptions,
): Promise<OfficialMarketplaceSnapshot | undefined> {
  return Effect.runPromise(bootstrapOfficialMarketplaceEffect(options));
}

function bootstrapOfficialMarketplaceEffect(
  options: OfficialMarketplaceBootstrapOptions,
): Effect.Effect<OfficialMarketplaceSnapshot | undefined, unknown> {
  return Effect.gen(function* () {
    const selectedNames = selectedOfficialCuratedPluginNames(options.selectedPluginIds);
    if (selectedNames.length === 0) return undefined;
    yield* validateBootstrapBounds(options.timeoutMs, options.pollIntervalMs);
    if (options.signal?.aborted) {
      return yield* Effect.fail(
        new OfficialPluginAdapterError(
          "cancelled",
          "Official Codex marketplace bootstrap was cancelled.",
        ),
      );
    }
    const initial = yield* options.readSnapshot === undefined
      ? readOfficialMarketplaceSnapshotAtRoot(
          join(options.codexHome, ...OFFICIAL_CURATED_MARKETPLACE_DIRECTORY),
          options.codexHome,
          selectedNames,
        )
      : Effect.tryPromise({
          try: () => options.readSnapshot!(options.codexHome),
          catch: (error) => error,
        });
    if (initial !== undefined && hasSelectedMarketplacePlugins(initial, selectedNames)) {
      return initial;
    }

    const initializeRuntime =
      options.initializeRuntime === undefined
        ? initializeOfficialRuntimeEffect(options)
        : Effect.tryPromise({ try: () => options.initializeRuntime!(), catch: (error) => error });
    let startupFailure: OfficialPluginAdapterError | undefined;
    const initialized = yield* initializeRuntime.pipe(
      Effect.map((closeRuntime) => ({ closeRuntime })),
      Effect.catchIf(
        () => true,
        (error) => Effect.succeed({ error }),
      ),
    );
    if ("error" in initialized) {
      startupFailure = marketplaceBootstrapError(
        "marketplace_unavailable",
        "Codex runtime initialization could not start the official marketplace sync. Check that Codex is available and its network/policy settings permit the official marketplace.",
        initialized.error,
      );
    } else if (initialized.closeRuntime !== undefined) {
      const polling = Effect.gen(function* () {
        const timeoutMs = options.timeoutMs ?? DEFAULT_MARKETPLACE_BOOTSTRAP_TIMEOUT_MS;
        const pollIntervalMs =
          options.pollIntervalMs ?? DEFAULT_MARKETPLACE_BOOTSTRAP_POLL_INTERVAL_MS;
        const startedAt = Date.now();
        while (Date.now() - startedAt <= timeoutMs) {
          if (options.signal?.aborted) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "cancelled",
                "Official Codex marketplace bootstrap was cancelled.",
              ),
            );
          }
          const latest = yield* options.readSnapshot === undefined
            ? readOfficialMarketplaceSnapshotAtRoot(
                join(options.codexHome, ...OFFICIAL_CURATED_MARKETPLACE_DIRECTORY),
                options.codexHome,
                selectedNames,
              )
            : Effect.tryPromise({
                try: () => options.readSnapshot!(options.codexHome),
                catch: (error) => error,
              });
          if (latest !== undefined && hasSelectedMarketplacePlugins(latest, selectedNames)) {
            return latest;
          }
          const remaining = timeoutMs - (Date.now() - startedAt);
          if (remaining <= 0) break;
          const delay = Math.min(pollIntervalMs, remaining);
          yield* options.sleep === undefined
            ? Effect.sleep(delay)
            : Effect.tryPromise({ try: () => options.sleep!(delay), catch: (error) => error });
        }
        return yield* Effect.fail(
          marketplaceBootstrapError(
            "marketplace_timeout",
            "The official Codex marketplace did not become ready before the bounded wait expired. Check network access and Codex marketplace policy, then retry.",
          ),
        );
      });
      const polled = yield* Effect.acquireUseRelease(
        Effect.succeed(initialized.closeRuntime),
        () =>
          polling.pipe(
            Effect.map((snapshot) => ({ snapshot })),
            Effect.catchIf(
              () => true,
              (error) => Effect.succeed({ error }),
            ),
          ),
        (closeRuntime) => Effect.tryPromise({ try: () => closeRuntime(), catch: () => undefined }),
      );
      if ("snapshot" in polled) return polled.snapshot;
      if (polled.error instanceof OfficialPluginAdapterError && polled.error.code === "cancelled") {
        return yield* Effect.fail(polled.error);
      }
      startupFailure =
        polled.error instanceof OfficialPluginAdapterError
          ? polled.error
          : marketplaceBootstrapError(
              "marketplace_unavailable",
              "The official marketplace sync failed before its bounded wait completed.",
              polled.error,
            );
    }
    if (options.gitFallback !== false) {
      return yield* Effect.tryPromise({
        try: () =>
          provisionOfficialMarketplaceSnapshot({
            codexHome: options.codexHome,
            selectedPluginIds: options.selectedPluginIds,
            ...(options.environment === undefined ? {} : { environment: options.environment }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.gitFallback === undefined ? {} : options.gitFallback),
          }),
        catch: (error) => error,
      }).pipe(
        Effect.mapError((error) =>
          error instanceof OfficialPluginAdapterError
            ? error
            : marketplaceBootstrapError(
                "marketplace_unavailable",
                `The official marketplace could not be populated after runtime startup (${startupFailure?.code ?? "unavailable"}). Check network access and retry.`,
                error,
              ),
        ),
      );
    }
    return yield* Effect.fail(
      startupFailure ??
        marketplaceBootstrapError(
          "marketplace_timeout",
          "The official Codex marketplace did not become ready before the bounded wait expired.",
        ),
    );
  });
}

/** Options for configuring official marketplace provision. */
export interface OfficialMarketplaceProvisionOptions {
  /** Codex home directory used by the server. */
  readonly codexHome: string;
  /** Selected plugin ids in the official marketplace provision options contract. */
  readonly selectedPluginIds: readonly string[];
  /** Environment variables passed to the process. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Signal in the official marketplace provision options contract. */
  readonly signal?: AbortSignal;
  /** Timeout ms in the official marketplace provision options contract. */
  readonly timeoutMs?: number;
  /** Git runner in the official marketplace provision options contract. */
  readonly gitRunner?: OfficialPluginCommandRunner;
  /** Test seam for a deterministic staged snapshot; production uses git clone. */
  readonly cloneSnapshot?: (source: string, destination: string) => Promise<void>;
  /** Test seam for transient publication failures; production uses an atomic filesystem rename. */
  readonly renameSnapshot?: (source: string, destination: string) => Promise<void>;
}

/**
 * Fetch and publish the canonical official snapshot when Codex startup did not provide it. This is
 * deliberately a separate fallback boundary: it never invokes `plugin marketplace add` and never
 * writes Codex configuration.
 */
export function provisionOfficialMarketplaceSnapshot(
  options: OfficialMarketplaceProvisionOptions,
): Promise<OfficialMarketplaceSnapshot> {
  return Effect.runPromise(provisionOfficialMarketplaceSnapshotEffect(options));
}

function provisionOfficialMarketplaceSnapshotEffect(
  options: OfficialMarketplaceProvisionOptions,
): Effect.Effect<OfficialMarketplaceSnapshot, unknown> {
  return Effect.gen(function* () {
    const selectedNames = selectedOfficialCuratedPluginNames(options.selectedPluginIds);
    if (selectedNames.length === 0) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The official marketplace fallback requires at least one selected provider plugin.",
        ),
      );
    }
    yield* validateBootstrapBounds(options.timeoutMs, undefined);
    if (!isAbsolute(options.codexHome)) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The Codex home for official marketplace fallback must be absolute.",
        ),
      );
    }
    if (options.signal?.aborted) {
      return yield* Effect.fail(
        new OfficialPluginAdapterError(
          "cancelled",
          "Official Codex marketplace fallback was cancelled.",
        ),
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
    const remoteHead = yield* resolveOfficialMarketplaceHead(
      gitRunner,
      timeoutMs,
      options.signal,
    ).pipe(
      Effect.mapError((error) =>
        error instanceof OfficialPluginAdapterError
          ? error
          : marketplaceBootstrapError(
              "marketplace_unavailable",
              "The official Codex marketplace remote HEAD could not be resolved. Check network access and retry.",
              error,
            ),
      ),
    );
    const pluginsParent = join(options.codexHome, "plugins");
    const targetRoot = join(pluginsParent, OFFICIAL_CURATED_MARKETPLACE_DIRECTORY[1]);
    yield* ensureFallbackParent(pluginsParent, options.codexHome);
    const existing = yield* Effect.catchIf(
      Effect.tryPromise({ try: () => lstat(targetRoot), catch: (error) => error }),
      isFileMissing,
      () => Effect.succeed(undefined),
    ).pipe(
      Effect.mapError((error) =>
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The reserved official marketplace path could not be inspected safely.",
          error,
        ),
      ),
    );
    if (existing !== undefined) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The reserved official marketplace path appeared during bootstrap; refusing to overwrite it.",
        ),
      );
    }
    const stagingRoot = yield* Effect.tryPromise({
      try: () => mkdtemp(join(pluginsParent, ".openai-plugins-stage-")),
      catch: (error) => error,
    });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(stagingRoot),
      (stage) =>
        Effect.gen(function* () {
          yield* assertReservedPathHasNoSymlink(options.codexHome, stage);
          if (options.cloneSnapshot !== undefined) {
            yield* Effect.tryPromise({
              try: () => options.cloneSnapshot!(OFFICIAL_CURATED_MARKETPLACE_SOURCE, stage),
              catch: (error) => error,
            }).pipe(
              Effect.mapError((error) => {
                // The test seam may fail before tree validation when the host refuses symlink creation.
                return isFilesystemPermissionError(error)
                  ? marketplaceBootstrapError(
                      "marketplace_invalid",
                      "The staged official marketplace could not be created as a safe file tree.",
                      error,
                    )
                  : error;
              }),
            );
          } else {
            const result = yield* Effect.tryPromise({
              try: () =>
                gitRunner.run(
                  [
                    "-c",
                    "core.longpaths=true",
                    "clone",
                    "--depth=1",
                    "--no-tags",
                    OFFICIAL_CURATED_MARKETPLACE_SOURCE,
                    stage,
                  ],
                  {
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                    timeoutMs,
                  },
                ),
              catch: (error) => error,
            });
            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                marketplaceBootstrapError(
                  "marketplace_unavailable",
                  "The official Codex marketplace could not be downloaded. Check network access and retry.",
                  result.stderr,
                ),
              );
            }
          }
          yield* assertNoSymlinkTree(stage);
          const stagedSnapshot = yield* readOfficialMarketplaceSnapshotAtRoot(
            stage,
            options.codexHome,
            selectedNames,
          );
          if (
            stagedSnapshot === undefined ||
            !hasSelectedMarketplacePlugins(stagedSnapshot, selectedNames)
          ) {
            return yield* Effect.fail(
              marketplaceBootstrapError(
                "marketplace_invalid",
                "The downloaded official marketplace is missing the selected plugin entries or manifest.",
              ),
            );
          }
          const checkedOutHead = yield* readCheckedOutHead(
            gitRunner,
            stage,
            timeoutMs,
            options.signal,
          );
          if (checkedOutHead !== remoteHead) {
            return yield* Effect.fail(
              marketplaceBootstrapError(
                "marketplace_invalid",
                "The downloaded official marketplace did not match the verified remote HEAD.",
              ),
            );
          }
          const collision = yield* Effect.catchIf(
            Effect.tryPromise({ try: () => lstat(targetRoot), catch: (error) => error }),
            isFileMissing,
            () => Effect.succeed(undefined),
          ).pipe(
            Effect.mapError((error) =>
              marketplaceBootstrapError(
                "marketplace_invalid",
                "The reserved official marketplace path could not be checked before publication.",
                error,
              ),
            ),
          );
          if (collision !== undefined) {
            return yield* Effect.fail(
              marketplaceBootstrapError(
                "marketplace_invalid",
                "The reserved official marketplace path appeared during staging; refusing to overwrite it.",
              ),
            );
          }
          yield* publishOfficialMarketplaceSnapshot(
            stage,
            targetRoot,
            options.renameSnapshot ?? rename,
          );
          const published = yield* readOfficialMarketplaceSnapshotAtRoot(
            join(options.codexHome, ...OFFICIAL_CURATED_MARKETPLACE_DIRECTORY),
            options.codexHome,
            selectedNames,
          );
          if (published === undefined || !hasSelectedMarketplacePlugins(published, selectedNames)) {
            return yield* Effect.fail(
              marketplaceBootstrapError(
                "marketplace_invalid",
                "The published official marketplace failed validation.",
              ),
            );
          }
          return published;
        }).pipe(
          Effect.mapError((error) =>
            error instanceof OfficialPluginAdapterError
              ? error
              : marketplaceBootstrapError(
                  "marketplace_unavailable",
                  "The official Codex marketplace fallback failed safely. Check network access and retry.",
                  error,
                ),
          ),
        ),
      (stage) =>
        Effect.tryPromise({
          try: () => rm(stage, { recursive: true, force: true }),
          catch: () => undefined,
        }),
    );
  });
}

function publishOfficialMarketplaceSnapshot(
  stagingRoot: string,
  targetRoot: string,
  publish: (source: string, destination: string) => Promise<void>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (let attempt = 0; ; attempt += 1) {
      const published = yield* Effect.tryPromise({
        try: () => publish(stagingRoot, targetRoot),
        catch: (error) => error,
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchIf(
          () => true,
          (error) => Effect.succeed({ ok: false as const, error }),
        ),
      );
      if (published.ok) return;
      const error = published.error;
      const retryDelay = WINDOWS_SNAPSHOT_RENAME_RETRY_DELAYS_MS[attempt];
      if (
        process.platform !== "win32" ||
        retryDelay === undefined ||
        !isTransientWindowsRenameError(error)
      ) {
        return yield* Effect.fail(error);
      }
      const collision = yield* Effect.catchIf(
        Effect.tryPromise({
          try: () => lstat(targetRoot),
          catch: (inspectionError) => inspectionError,
        }),
        isFileMissing,
        () => Effect.succeed(undefined),
      ).pipe(
        Effect.mapError((inspectionError) =>
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The reserved official marketplace path could not be checked before retrying publication.",
            inspectionError,
          ),
        ),
      );
      if (collision !== undefined) {
        return yield* Effect.fail(
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The reserved official marketplace path appeared during publication; refusing to overwrite it.",
          ),
        );
      }
      yield* Effect.sleep(retryDelay);
    }
  });
}

function isTransientWindowsRenameError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EBUSY")
  );
}

function resolveOfficialMarketplaceHead(
  gitRunner: OfficialPluginCommandRunner,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        gitRunner.run(["ls-remote", OFFICIAL_CURATED_MARKETPLACE_SOURCE, "HEAD"], {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs,
        }),
      catch: (error) => error,
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_unavailable",
          "The official Codex marketplace remote HEAD could not be resolved. Check network access and retry.",
          result.stderr,
        ),
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
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The official Codex marketplace remote HEAD response was malformed.",
        ),
      );
    }
    return match[1].toLowerCase();
  });
}

function readCheckedOutHead(
  gitRunner: OfficialPluginCommandRunner,
  stagingRoot: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        gitRunner.run(["rev-parse", "HEAD"], {
          timeoutMs,
          cwd: stagingRoot,
          ...(signal === undefined ? {} : { signal }),
        }),
      catch: (error) => error,
    });
    const head = result.stdout.trim().toLowerCase();
    if (result.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The downloaded official marketplace checkout did not expose a valid HEAD.",
          result.stderr,
        ),
      );
    }
    return head;
  });
}

function ensureFallbackParent(parent: string, codexHome: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* assertNoSymlinkAncestors(codexHome, parent);
    yield* Effect.tryPromise({
      try: () => mkdir(parent, { recursive: true }),
      catch: (error) => error,
    });
    yield* assertNoSymlinkAncestors(codexHome, parent);
  });
}

function assertNoSymlinkAncestors(root: string, target: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const rootPath = resolve(root);
    let current = resolve(target);
    while (true) {
      const entry = yield* Effect.catchIf(
        Effect.tryPromise({ try: () => lstat(current), catch: (error) => error }),
        isFileMissing,
        () => Effect.succeed(undefined),
      );
      if (entry?.isSymbolicLink()) {
        return yield* Effect.fail(
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The official marketplace path cannot contain symlinks.",
          ),
        );
      }
      if (current === rootPath) return;
      const parent = dirname(current);
      if (parent === current || (parent !== rootPath && !pathIsWithin(rootPath, parent))) {
        return yield* Effect.fail(
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The official marketplace path escaped CODEX_HOME.",
          ),
        );
      }
      current = parent;
    }
  });
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

function assertNoSymlinkTree(root: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const entry = yield* Effect.tryPromise({ try: () => lstat(root), catch: (error) => error });
    if (entry.isSymbolicLink()) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The official marketplace snapshot cannot contain symlinks.",
        ),
      );
    }
    if (!entry.isDirectory()) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The official marketplace snapshot is not a directory.",
        ),
      );
    }
    const entries = yield* Effect.tryPromise({
      try: () => readdir(root, { withFileTypes: true }),
      catch: (error) => error,
    });
    for (const child of entries) {
      const path = join(root, child.name);
      const childEntry = yield* Effect.tryPromise({
        try: () => lstat(path),
        catch: (error) => error,
      });
      if (childEntry.isSymbolicLink()) {
        return yield* Effect.fail(
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The official marketplace snapshot cannot contain symlinks.",
          ),
        );
      }
      if (childEntry.isDirectory()) yield* assertNoSymlinkTree(path);
    }
  });
}

/** Read a trusted marketplace snapshot, optionally scoped to selected providers. */
export function readOfficialMarketplaceSnapshot(
  codexHome: string,
  selectedPluginIds: readonly string[] = [],
): Promise<OfficialMarketplaceSnapshot | undefined> {
  return Effect.runPromise(
    readOfficialMarketplaceSnapshotAtRoot(
      join(codexHome, ...OFFICIAL_CURATED_MARKETPLACE_DIRECTORY),
      codexHome,
      selectedOfficialCuratedPluginNames(selectedPluginIds),
    ),
  );
}

function readOfficialMarketplaceSnapshotAtRoot(
  rootPath: string,
  codexHome: string | undefined,
  selectedNames: readonly string[] = [],
): Effect.Effect<OfficialMarketplaceSnapshot | undefined, unknown> {
  return Effect.gen(function* () {
    // Validate the complete reserved path before checking the leaf.  When the
    // leaf is absent, a symlinked ancestor would otherwise be treated as a
    // normal "not populated yet" state and App Server startup could populate
    // content outside CODEX_HOME.
    if (codexHome !== undefined) {
      yield* assertNoSymlinkAncestors(codexHome, rootPath);
    }
    const rootEntry = yield* Effect.catchIf(
      Effect.tryPromise({ try: () => lstat(rootPath), catch: (error) => error }),
      isFileMissing,
      () => Effect.succeed(undefined),
    ).pipe(
      Effect.mapError((error) =>
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The reserved openai-curated marketplace path could not be read safely.",
          error,
        ),
      ),
    );
    if (rootEntry === undefined) return undefined;
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The reserved openai-curated marketplace path is not a real directory.",
        ),
      );
    }
    if (codexHome !== undefined) {
      yield* assertReservedPathHasNoSymlink(codexHome, rootPath);
    } else {
      yield* assertNoSymlinkTree(rootPath);
    }
    if (codexHome !== undefined) yield* assertNoSymlinkTree(rootPath);
    const root = yield* Effect.tryPromise({
      try: () => realpath(rootPath),
      catch: (error) => error,
    });
    const candidates = [
      join(root, ".agents", "plugins", "marketplace.json"),
      join(root, ".codex-plugin", "marketplace.json"),
      join(root, "marketplace.json"),
    ];
    let manifestPath: string | undefined;
    let contents: string | undefined;
    for (const candidate of candidates) {
      const entry = yield* Effect.catchIf(
        Effect.tryPromise({ try: () => lstat(candidate), catch: (error) => error }),
        isFileMissing,
        () => Effect.succeed(undefined),
      ).pipe(
        Effect.mapError((error) =>
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The official marketplace manifest could not be read safely.",
            error,
          ),
        ),
      );
      if (entry === undefined) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        return yield* Effect.fail(
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The official marketplace manifest is not a regular file.",
          ),
        );
      }
      yield* assertReservedPathHasNoSymlink(root, candidate);
      if (manifestPath !== undefined) {
        return yield* Effect.fail(
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The reserved official marketplace contains more than one manifest.",
          ),
        );
      }
      manifestPath = candidate;
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(candidate),
        catch: (error) => error,
      });
      contents = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: (error) =>
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The official marketplace manifest is not valid UTF-8.",
            error,
          ),
      });
    }
    if (manifestPath === undefined || contents === undefined) return undefined;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(contents!) as unknown,
      catch: (error) =>
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The official marketplace manifest is not valid JSON.",
          error,
        ),
    });
    return yield* Effect.try({
      try: () => parseOfficialMarketplaceSnapshot(parsed, root, manifestPath!, selectedNames),
      catch: (error) => error,
    });
  });
}

/** Parse a trusted marketplace manifest and validate the selected provider entries. */
export function parseOfficialMarketplaceSnapshot(
  input: unknown,
  rootPath = `${OFFICIAL_CURATED_MARKETPLACE_DIRECTORY.join("/")}`,
  manifestPath = `${rootPath}/marketplace.json`,
  selectedNames: readonly string[] = [],
): OfficialMarketplaceSnapshot {
  const decoded = Schema.decodeUnknownResult(MarketplaceManifestSchema)(input);
  if (Result.isFailure(decoded)) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The reserved official marketplace manifest is malformed or has an unexpected name.",
    );
  }
  const manifest = decoded.success;
  if (!validateOfficialMarketplaceSource(manifest)) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The reserved official marketplace source is not the approved OpenAI repository.",
    );
  }
  if (manifest.plugins.length === 0) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace manifest has no plugin entries.",
    );
  }
  const plugins: OfficialMarketplacePluginEntry[] = [];
  const names = new Set<string>();
  for (const rawPlugin of manifest.plugins) {
    const decodedPlugin = Schema.decodeUnknownResult(MarketplacePluginSchema)(rawPlugin);
    if (Result.isFailure(decodedPlugin)) {
      if (selectedNames.length > 0) continue;
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace contains a malformed plugin entry.",
      );
    }
    const plugin = decodedPlugin.success;
    const name = plugin.name;
    if (names.has(name)) {
      if (selectedNames.length > 0 && !selectedNames.includes(name)) continue;
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace contains a duplicate plugin name.",
      );
    }
    names.add(name);
    if (selectedNames.length > 0 && !selectedNames.includes(name)) continue;
    const source = marketplacePluginSource(plugin);
    const safeSource =
      source === undefined
        ? undefined
        : Schema.decodeUnknownResult(SafeMarketplacePathSchema)(source);
    if (safeSource === undefined || Result.isFailure(safeSource)) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        `The official marketplace source for ${name} is unsafe.`,
      );
    }
    plugins.push({ name, source: safeSource.success });
  }
  if (selectedNames.some((name) => !plugins.some((plugin) => plugin.name === name))) {
    throw marketplaceBootstrapError(
      "marketplace_invalid",
      "The official marketplace is missing a selected plugin entry.",
    );
  }
  return {
    name: OFFICIAL_CURATED_MARKETPLACE_NAME,
    source: OFFICIAL_CURATED_MARKETPLACE_SOURCE,
    rootPath,
    manifestPath,
    plugins,
  };
}

function validateOfficialMarketplaceSource(input: typeof MarketplaceManifestSchema.Type): boolean {
  return ([input.source, input.repository, input.repo, input.url] as const).every(
    (value) =>
      value === undefined ||
      Result.isSuccess(Schema.decodeUnknownResult(ApprovedMarketplaceSourceSchema)(value)),
  );
}

function marketplacePluginSource(input: typeof MarketplacePluginSchema.Type): string | undefined {
  const source = input.source;
  if (typeof source === "string") return source;
  if (source?.path !== undefined) return source.path;
  if (input.path !== undefined) return input.path;
  return undefined;
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
    if (
      marketplace !== OFFICIAL_CURATED_MARKETPLACE_NAME &&
      marketplace !== "openai-curated-remote"
    ) {
      continue;
    }
    const name = pluginId.slice(0, separator);
    if (Result.isFailure(Schema.decodeUnknownResult(PluginNameSchema)(name))) {
      throw marketplaceBootstrapError(
        "marketplace_invalid",
        "A selected official marketplace plugin id is invalid.",
      );
    }
    if (!isRecognizedOfficialPluginName(name)) continue;
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

function initializeOfficialRuntimeEffect(
  options: OfficialMarketplaceBootstrapOptions,
): Effect.Effect<OfficialMarketplaceRuntimeClose, unknown> {
  return Effect.gen(function* () {
    const environment = allowlistedEnvironment(options.environment);
    const transport = new BunStdioTransport({
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
    yield* Effect.tryPromise({ try: () => client.initialize(), catch: (error) => error }).pipe(
      Effect.onError(() =>
        Effect.tryPromise({ try: () => transport.close(), catch: (error) => error }).pipe(
          Effect.ignore,
        ),
      ),
    );
    return () =>
      Effect.runPromise(
        Effect.tryPromise({ try: () => client.close(), catch: (error) => error }).pipe(
          Effect.ignore,
        ),
      );
  });
}

function validateBootstrapBounds(
  timeoutMs: number | undefined,
  pollIntervalMs: number | undefined,
): Effect.Effect<void, OfficialPluginAdapterError> {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000)
  ) {
    return Effect.fail(
      marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace timeout is invalid.",
      ),
    );
  }
  if (
    pollIntervalMs !== undefined &&
    (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000)
  ) {
    return Effect.fail(
      marketplaceBootstrapError(
        "marketplace_invalid",
        "The official marketplace poll interval is invalid.",
      ),
    );
  }
  return Effect.void;
}

function assertReservedPathHasNoSymlink(
  codexHome: string,
  rootPath: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const home = yield* Effect.tryPromise({
      try: () => realpath(codexHome),
      catch: (error) => error,
    });
    const root = yield* Effect.tryPromise({
      try: () => realpath(rootPath),
      catch: (error) => error,
    });
    const remainder = relative(home, root);
    if (remainder === "" || remainder === ".." || remainder.startsWith(`..${sep}`)) {
      return yield* Effect.fail(
        marketplaceBootstrapError(
          "marketplace_invalid",
          "The reserved official marketplace is outside CODEX_HOME.",
        ),
      );
    }
    const homePath = resolve(codexHome);
    let current = resolve(rootPath);
    while (true) {
      const entry = yield* Effect.tryPromise({
        try: () => lstat(current),
        catch: (error) => error,
      });
      if (entry.isSymbolicLink()) {
        return yield* Effect.fail(
          marketplaceBootstrapError(
            "marketplace_invalid",
            "The reserved official marketplace path cannot contain symlinks.",
          ),
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
  });
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFilesystemPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES")
  );
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

/** Decode an official plugin manifest and reject payloads containing MCP declarations. */
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

/** Validate an official plugin manifest and mark it as not explicitly selected. */
export function verifyOfficialPluginManifest(input: unknown): OfficialPluginVerification {
  const parsed = parseOfficialPluginManifest(input);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return { manifest: parsed.value, explicitlySelected: false };
}

/** Read and validate an official plugin manifest from a regular plugin root file. */
export function verifyOfficialPluginManifestFile(
  pluginRoot: string,
): Promise<OfficialPluginVerification> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise({
        try: () => realpath(pluginRoot),
        catch: (error) =>
          new CodexError(
            "manifest_invalid",
            "The official plugin root is invalid.",
            {},
            { cause: error },
          ),
      });
      const rootEntry = yield* Effect.tryPromise({
        try: () => stat(root),
        catch: (error) =>
          new CodexError(
            "manifest_invalid",
            "The official plugin root is invalid.",
            {},
            { cause: error },
          ),
      });
      if (!rootEntry.isDirectory()) {
        return yield* Effect.fail(
          new CodexError("manifest_invalid", "The official plugin root is invalid."),
        );
      }
      const manifestPath = join(root, ".codex-plugin", "plugin.json");
      const manifestEntry = yield* Effect.tryPromise({
        try: () => lstat(manifestPath),
        catch: (error) =>
          new CodexError(
            "manifest_invalid",
            "The plugin is missing .codex-plugin/plugin.json.",
            {},
            { cause: error },
          ),
      });
      if (manifestEntry.isSymbolicLink() || !manifestEntry.isFile()) {
        return yield* Effect.fail(
          new CodexError("manifest_invalid", "The plugin manifest is not a regular file."),
        );
      }
      const contents = yield* Effect.tryPromise({
        try: () => readFile(manifestPath),
        catch: (error) =>
          new CodexError(
            "manifest_invalid",
            "The plugin is missing .codex-plugin/plugin.json.",
            {},
            { cause: error },
          ),
      }).pipe(
        Effect.flatMap((bytes) =>
          Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: (error) =>
              new CodexError(
                "manifest_invalid",
                "The plugin manifest is not valid UTF-8.",
                {},
                { cause: error },
              ),
          }),
        ),
      );
      const parsedJson = yield* Effect.try({
        // JSON.parse is immediately validated by the manifest schema and MCP-key scan.
        try: () => JSON.parse(contents) as unknown,
        catch: (error) =>
          new CodexError(
            "manifest_invalid",
            "The plugin manifest is not valid JSON.",
            {},
            { cause: error },
          ),
      });
      const verification = yield* Effect.try({
        try: () => verifyOfficialPluginManifest(parsedJson),
        catch: (error) => error,
      });
      return { ...verification, manifestPath };
    }),
  );
}

/** Validates official plugin selection values at the Codex boundary. */
export const OfficialPluginSelectionSchema = Schema.Struct({
  id: PluginNameSchema,
  selected: Schema.Literals([true]),
});
/** Type of official plugin selection values. */
export type OfficialPluginSelection = typeof OfficialPluginSelectionSchema.Type;

/** Validate explicit official plugin selections and return their corresponding manifests. */
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

/** Validates live official plugin entry values at the Codex boundary. */
export const LiveOfficialPluginEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    pluginId: OfficialPluginIdSchema,
    installed: Schema.Boolean,
    enabled: Schema.Boolean,
    name: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
    marketplaceName: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
    version: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
/** Type of live official plugin entry values. */
export type LiveOfficialPluginEntry = typeof LiveOfficialPluginEntrySchema.Type;

/** Validates live official plugin list envelope values at the Codex boundary. */
export const LiveOfficialPluginListEnvelopeSchema = Schema.Struct({
  installed: Schema.Array(LiveOfficialPluginEntrySchema),
  available: Schema.Array(LiveOfficialPluginEntrySchema),
});
/** Type of live official plugin list envelope values. */
export type LiveOfficialPluginListEnvelope = typeof LiveOfficialPluginListEnvelopeSchema.Type;

/** Type of resolved official plugin entry values. */
export type ResolvedOfficialPluginEntry = Readonly<{
  readonly identity: OfficialPluginIdentity;
  readonly entry: LiveOfficialPluginEntry;
}>;

/**
 * Resolve a canonical capability provider to a live trusted OpenAI plugin entry.
 *
 * The id and marketplaceName must describe the same recognized marketplace. Exact canonical entries
 * are preferred over the remote runtime identity; unrelated marketplaces are ignored.
 */
export function resolveOfficialPluginEntry(
  live: LiveOfficialPluginListEnvelope,
  canonicalPluginId: string,
): ResolvedOfficialPluginEntry | undefined {
  const canonical = canonicalOfficialPluginId(canonicalPluginId);
  if (canonical === undefined || canonical !== canonicalPluginId) return undefined;
  const entries = [...live.installed, ...live.available];
  const matches = entries.flatMap((entry) => {
    const identity = resolveOfficialPluginIdentity(entry.pluginId, entry.marketplaceName);
    return identity?.canonicalPluginId === canonical ? [{ identity, entry }] : [];
  });
  return (
    matches.find((match) => match.entry.pluginId === canonical && match.entry.installed) ??
    matches.find((match) => match.entry.installed) ??
    matches.find((match) => match.entry.pluginId === canonical) ??
    matches[0]
  );
}

/** Return whether a provider name is one of the capability providers trusted by HolyCodex. */
export function isRecognizedOfficialPluginName(name: string): boolean {
  return (OFFICIAL_OPENAI_CURATED_PLUGIN_NAMES as readonly string[]).includes(name);
}

/** Decode the Codex plugin list response used to reconcile official providers. */
export function parseLiveOfficialPluginList(
  input: unknown,
): CodexResult<LiveOfficialPluginListEnvelope> {
  if (!isValid(LiveOfficialPluginListEnvelopeSchema, input)) {
    return failure(invalidData("live official plugin list", input));
  }
  return success(checked(LiveOfficialPluginListEnvelopeSchema, input, "live official plugin list"));
}

/** Data contract for official plugin command runner. */
export interface OfficialPluginCommandRunner {
  /** Run in the official plugin command runner contract. */
  readonly run: (
    args: readonly string[],
    options?: Readonly<{
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly cwd?: string;
    }>,
  ) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
}

/** Options for configuring official plugin adapter. */
export interface OfficialPluginAdapterOptions {
  /** Executable in the official plugin adapter options contract. */
  readonly executable: string;
  /** Environment variables passed to the process. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Codex home directory used by the server. */
  readonly codexHome?: string;
  /** Official marketplace fallback in the official plugin adapter options contract. */
  readonly officialMarketplaceFallback?: OfficialMarketplaceGitFallbackOptions | false;
  /** Runner in the official plugin adapter options contract. */
  readonly runner?: OfficialPluginCommandRunner;
  /** Timeout ms in the official plugin adapter options contract. */
  readonly timeoutMs?: number;
  /** Stdout limit in the official plugin adapter options contract. */
  readonly stdoutLimit?: number;
  /** Stderr limit in the official plugin adapter options contract. */
  readonly stderrLimit?: number;
  /** Report a required marketplace replacement before Codex state is changed. */
  readonly onMarketplaceConflict?: (message: string) => void;
}

/** Data contract for official plugin adapter. */
export interface OfficialPluginAdapter {
  /** List in the official plugin adapter contract. */
  readonly list: () => Promise<LiveOfficialPluginListEnvelope>;
  /** Ensure official marketplace in the official plugin adapter contract. */
  readonly ensureOfficialMarketplace: (selectedPluginIds: readonly string[]) => Promise<void>;
  /** Add the canonical HolyCodex marketplace or refresh it, then verify its registered source. */
  readonly addMarketplace: (source: string, signal?: AbortSignal) => Promise<void>;
  /** Add in the official plugin adapter contract. */
  readonly add: (pluginId: string, signal?: AbortSignal) => Promise<void>;
  /** Remove in the official plugin adapter contract. */
  readonly remove: (pluginId: string, signal?: AbortSignal) => Promise<void>;
}

interface MarketplaceListEntry {
  readonly name: string;
  readonly root: string;
  readonly marketplaceSource?: Readonly<{ readonly sourceType: string; readonly source: string }>;
}

const MarketplaceRegistrationSourceSchema = Schema.StructWithRest(
  Schema.Struct({ sourceType: Schema.String, source: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const MarketplaceListEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String,
    root: Schema.String,
    marketplaceSource: Schema.optional(MarketplaceRegistrationSourceSchema),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const MarketplaceListEnvelopeSchema = Schema.StructWithRest(
  Schema.Struct({ marketplaces: Schema.Array(MarketplaceListEntrySchema) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** Structured failure raised by the official Codex plugin adapter. */
export class OfficialPluginAdapterError extends Error {
  /** Code in the official plugin adapter error contract. */
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
  /** Details in the official plugin adapter error contract. */
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

/** Create the command-backed adapter for listing, installing, and removing Codex plugins. */
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
  const listEffect = Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => runner.run(["plugin", "list", "--json"]),
      catch: (error) => error,
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(commandError("list", result));
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(result.stdout) as unknown,
      catch: () =>
        new OfficialPluginAdapterError("command_failed", "Codex returned invalid plugin data."),
    });
    const decoded = parseLiveOfficialPluginList(parsed);
    if (!decoded.ok) {
      return yield* Effect.fail(
        new OfficialPluginAdapterError(
          "command_failed",
          "Codex returned an invalid official plugin list.",
        ),
      );
    }
    return decoded.value;
  });
  const list = (): Promise<LiveOfficialPluginListEnvelope> => Effect.runPromise(listEffect);
  const listMarketplacesEffect = Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => runner.run(["plugin", "marketplace", "list", "--json"]),
      catch: (error) => error,
    });
    if (result.exitCode !== 0) return yield* Effect.fail(commandError("marketplace list", result));
    const parsed = yield* Effect.try({
      try: () => JSON.parse(result.stdout) as unknown,
      catch: () =>
        new OfficialPluginAdapterError(
          "command_failed",
          "Codex returned invalid marketplace data.",
        ),
    });
    const decoded = Schema.decodeUnknownResult(MarketplaceListEnvelopeSchema)(parsed);
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(
        new OfficialPluginAdapterError(
          "command_failed",
          "Codex returned an invalid marketplace list.",
        ),
      );
    }
    return decoded.success.marketplaces.map((value) => ({
      name: value.name,
      root: value.root,
      ...(value.marketplaceSource === undefined
        ? {}
        : {
            marketplaceSource: {
              sourceType: value.marketplaceSource.sourceType,
              source: value.marketplaceSource.source,
            },
          }),
    }));
  });
  return {
    list,
    ensureOfficialMarketplace: (selectedPluginIds) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (options.codexHome === undefined) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "marketplace_unavailable",
                "Codex home is unavailable; the official marketplace cannot be bootstrapped safely.",
              ),
            );
          }
          yield* bootstrapOfficialMarketplaceEffect({
            codexHome: options.codexHome,
            executablePath: options.executable,
            selectedPluginIds,
            ...(options.environment === undefined ? {} : { environment: options.environment }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.officialMarketplaceFallback === undefined
              ? {}
              : { gitFallback: options.officialMarketplaceFallback }),
          });
        }),
      ),
    addMarketplace: (source, signal) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const checkedSource = checked(
            OfficialPluginIdSchema,
            source,
            "plugin marketplace source",
          );
          if (
            checkedSource === OFFICIAL_CURATED_MARKETPLACE_NAME ||
            checkedSource === OFFICIAL_CURATED_MARKETPLACE_SOURCE
          ) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "marketplace_invalid",
                "The reserved openai-curated marketplace must be populated by Codex runtime startup; it cannot be added manually.",
              ),
            );
          }
          if (checkedSource !== HOLYCODEX_MARKETPLACE_SOURCE) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "marketplace_invalid",
                `Unsupported managed marketplace source: ${checkedSource}.`,
              ),
            );
          }
          let initial: readonly MarketplaceListEntry[];
          let bootstrapped = false;
          const listed = yield* listMarketplacesEffect.pipe(
            Effect.map((value) => ({ value })),
            Effect.catchIf(isIncompleteHolyCodexMarketplaceSnapshot, (error) =>
              Effect.succeed({ error }),
            ),
          );
          if ("error" in listed) {
            options.onMarketplaceConflict?.(
              "The registered HolyCodex marketplace cache is incomplete; Codex will rebuild it from the canonical source.",
            );
            const result = yield* Effect.tryPromise({
              try: () =>
                runner.run(
                  ["plugin", "marketplace", "add", checkedSource],
                  signal === undefined ? undefined : { signal },
                ),
              catch: (error) => error,
            });
            if (result.exitCode !== 0) {
              return yield* Effect.fail(commandError("marketplace add", result, checkedSource));
            }
            initial = yield* listMarketplacesEffect;
            bootstrapped = true;
          } else {
            initial = listed.value;
          }
          const conflict = findMarketplaceConflict(initial, HOLYCODEX_MARKETPLACE_NAME);
          const conflictingNames = marketplaceConflictNames(initial, HOLYCODEX_MARKETPLACE_NAME);
          if (conflict !== undefined && conflictingNames.length > 0) {
            options.onMarketplaceConflict?.(
              `${conflict} HolyCodex will remove the conflicting registration and restore its required source.`,
            );
            for (const name of conflictingNames) {
              const result = yield* Effect.tryPromise({
                try: () =>
                  runner.run(
                    ["plugin", "marketplace", "remove", name],
                    signal === undefined ? undefined : { signal },
                  ),
                catch: (error) => error,
              });
              if (result.exitCode !== 0) {
                return yield* Effect.fail(commandError("marketplace remove", result, name));
              }
            }
          }
          const afterReconciliation =
            conflictingNames.length === 0 ? initial : yield* listMarketplacesEffect;
          const remainingConflict = findMarketplaceConflict(
            afterReconciliation,
            HOLYCODEX_MARKETPLACE_NAME,
          );
          if (remainingConflict !== undefined) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError("marketplace_invalid", remainingConflict),
            );
          }
          const existing = afterReconciliation.find(
            (entry) => entry.name === HOLYCODEX_MARKETPLACE_NAME,
          );
          if (existing === undefined) {
            const result = yield* Effect.tryPromise({
              try: () =>
                runner.run(
                  ["plugin", "marketplace", "add", checkedSource],
                  signal === undefined ? undefined : { signal },
                ),
              catch: (error) => error,
            });
            if (result.exitCode !== 0) {
              return yield* Effect.fail(commandError("marketplace add", result, checkedSource));
            }
          } else if (!bootstrapped) {
            const result = yield* Effect.tryPromise({
              try: () =>
                runner.run(
                  ["plugin", "marketplace", "upgrade", HOLYCODEX_MARKETPLACE_NAME],
                  signal === undefined ? undefined : { signal },
                ),
              catch: (error) => error,
            });
            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                commandError("marketplace upgrade", result, HOLYCODEX_MARKETPLACE_NAME),
              );
            }
          }
          const readback = yield* listMarketplacesEffect;
          const readbackConflict = findMarketplaceConflict(readback, HOLYCODEX_MARKETPLACE_NAME);
          if (readbackConflict !== undefined) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError("marketplace_invalid", readbackConflict),
            );
          }
          const verified = readback.find((entry) => entry.name === HOLYCODEX_MARKETPLACE_NAME);
          if (
            verified === undefined ||
            !isCanonicalHolyCodexMarketplaceSource(verified.marketplaceSource)
          ) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "readback_mismatch",
                "Codex did not report the canonical HolyCodex marketplace after installation or refresh.",
              ),
            );
          }
        }),
      ),
    add: (pluginId, signal) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const checkedPluginId = yield* Effect.try({
            try: () => checked(OfficialPluginIdSchema, pluginId, "official plugin id"),
            catch: (error) => error,
          });
          const candidates = officialPluginIdCandidates(checkedPluginId);
          const orderedCandidates =
            canonicalOfficialPluginId(checkedPluginId) === "computer-use@openai-bundled"
              ? candidates
              : candidates.includes(checkedPluginId)
                ? [
                    checkedPluginId,
                    ...candidates.filter((candidate) => candidate !== checkedPluginId),
                  ]
                : [checkedPluginId];
          let installed = false;
          for (const [index, candidate] of orderedCandidates.entries()) {
            const result = yield* Effect.tryPromise({
              try: () =>
                runner.run(
                  ["plugin", "add", candidate, "--json"],
                  signal === undefined ? undefined : { signal },
                ),
              catch: (error) => error,
            });
            if (result.exitCode === 0) {
              installed = true;
              break;
            }
            if (
              index < orderedCandidates.length - 1 &&
              isPluginUnavailableFromMarketplace(result.stderr)
            ) {
              continue;
            }
            return yield* Effect.fail(commandError("add", result, candidate));
          }
          if (!installed) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "command_failed",
                `Codex could not install ${checkedPluginId} from its recognized marketplace sources.`,
              ),
            );
          }
          const live = yield* listEffect;
          const resolved = resolveOfficialPluginEntry(live, checkedPluginId);
          const canonical = canonicalOfficialPluginId(checkedPluginId);
          const entries = [...live.installed, ...live.available].filter(
            (entry) =>
              entry.pluginId === checkedPluginId &&
              (canonical === undefined || entry.marketplaceName == null),
          );
          const entry =
            resolved?.entry ?? entries.find((candidate) => candidate.installed) ?? entries[0];
          if (!entry) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "readback_mismatch",
                `Codex did not report ${checkedPluginId} after installation.`,
                { plugin_id: checkedPluginId },
              ),
            );
          }
          if (!entry.installed) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "plugin_missing",
                `Codex reported ${checkedPluginId} as unavailable after installation.`,
                { plugin_id: checkedPluginId },
              ),
            );
          }
          if (!entry.enabled) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "plugin_disabled",
                `Codex installed ${checkedPluginId} but it is disabled; enable it in Codex and retry.`,
                { plugin_id: checkedPluginId },
              ),
            );
          }
        }),
      ),
    remove: (pluginId, signal) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const checkedPluginId = yield* Effect.try({
            try: () => checked(OfficialPluginIdSchema, pluginId, "official plugin id"),
            catch: (error) => error,
          });
          let removalId = checkedPluginId;
          if (canonicalOfficialPluginId(checkedPluginId) === checkedPluginId) {
            const before = yield* listEffect;
            const resolved = resolveOfficialPluginEntry(before, checkedPluginId);
            if (resolved?.entry.installed) removalId = resolved.entry.pluginId;
          }
          const result = yield* Effect.tryPromise({
            try: () =>
              runner.run(
                ["plugin", "remove", removalId, "--json"],
                signal === undefined ? undefined : { signal },
              ),
            catch: (error) => error,
          });
          if (result.exitCode !== 0 && !/not (?:installed|found)|missing/iu.test(result.stderr)) {
            return yield* Effect.fail(commandError("remove", result, removalId));
          }
          const live = yield* listEffect;
          const entry = [...live.installed, ...live.available].find(
            (candidate) => candidate.pluginId === removalId,
          );
          if (entry?.installed) {
            return yield* Effect.fail(
              new OfficialPluginAdapterError(
                "readback_mismatch",
                `Codex still reports ${checkedPluginId} after removal.`,
                { plugin_id: checkedPluginId, observed_plugin_id: entry.pluginId },
              ),
            );
          }
        }),
      ),
  };
}

function commandError(
  operation:
    | "list"
    | "add"
    | "remove"
    | "marketplace add"
    | "marketplace remove"
    | "marketplace list"
    | "marketplace upgrade",
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

function isPluginUnavailableFromMarketplace(stderr: string): boolean {
  return /plugin\b.+\bnot found in marketplace\b/iu.test(sanitizeDiagnostic(stderr));
}

function isIncompleteHolyCodexMarketplaceSnapshot(error: unknown): boolean {
  if (!(error instanceof OfficialPluginAdapterError) || error.code !== "command_failed") {
    return false;
  }
  const invalidMarketplace =
    /(?:^|[\n:])\s*-\s*`([^`]+)`\s+at\s+[^\r\n]*:\s*marketplace root does not contain a supported manifest/iu.exec(
      error.message,
    );
  return invalidMarketplace?.[1] === HOLYCODEX_MARKETPLACE_NAME;
}

function findMarketplaceConflict(
  entries: readonly MarketplaceListEntry[],
  expectedName: string,
): string | undefined {
  const named = entries.filter((entry) => entry.name === expectedName);
  if (named.length > 1) {
    return `Multiple Codex marketplaces use the reserved name ${expectedName}; resolve the duplicate configuration before installing HolyCodex.`;
  }
  if (
    named[0] !== undefined &&
    !isCanonicalHolyCodexMarketplaceSource(named[0].marketplaceSource)
  ) {
    const observed = named[0].marketplaceSource?.source ?? "an unknown source";
    return `Codex marketplace ${expectedName} points to ${observed}, not the canonical HolyCodex source ${HOLYCODEX_MARKETPLACE_SOURCE}; resolve the conflict before installing.`;
  }
  const alias = entries.find(
    (entry) =>
      entry.name !== expectedName && isCanonicalHolyCodexMarketplaceSource(entry.marketplaceSource),
  );
  if (alias !== undefined) {
    return `The canonical HolyCodex source is already registered as Codex marketplace ${alias.name}; resolve the noncanonical marketplace name before installing.`;
  }
  return undefined;
}

function marketplaceConflictNames(
  entries: readonly MarketplaceListEntry[],
  expectedName: string,
): readonly string[] {
  const named = entries.filter((entry) => entry.name === expectedName);
  const duplicateReservedName = named.length > 1;
  return [
    ...new Set(
      entries
        .filter(
          (entry) =>
            (entry.name === expectedName &&
              (duplicateReservedName ||
                !isCanonicalHolyCodexMarketplaceSource(entry.marketplaceSource))) ||
            (entry.name !== expectedName &&
              isCanonicalHolyCodexMarketplaceSource(entry.marketplaceSource)),
        )
        .map((entry) => entry.name),
    ),
  ];
}

function isCanonicalHolyCodexMarketplaceSource(
  source: MarketplaceListEntry["marketplaceSource"],
): boolean {
  if (source?.sourceType !== "git") return false;
  return isCanonicalHolyCodexMarketplaceGitSource(source.source);
}

/** Return whether a Git URL is a recognized canonical source for the HolyCodex marketplace. */
export function isCanonicalHolyCodexMarketplaceGitSource(source: string): boolean {
  return HOLYCODEX_MARKETPLACE_GIT_SOURCES.some((canonical) => canonical === source);
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

function runNodeBunCommand(
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
  return Effect.runPromise(runNodeBunCommandEffect(executable, args, options));
}

function runNodeBunCommandEffect(
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
): Effect.Effect<
  Readonly<{ exitCode: number; stdout: string; stderr: string }>,
  OfficialPluginAdapterError
> {
  return Effect.gen(function* () {
    if (options.signal?.aborted) {
      return yield* Effect.fail(
        new OfficialPluginAdapterError("cancelled", "The Codex plugin command was cancelled."),
      );
    }
    const child = spawn(executable, [...args], {
      env: options.environment === undefined ? undefined : { ...options.environment },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const exit = Effect.callback<number, OfficialPluginAdapterError>((resume) => {
      child.once("error", () =>
        resume(
          Effect.fail(
            new OfficialPluginAdapterError("command_failed", "The Codex plugin command failed."),
          ),
        ),
      );
      child.once("close", (code) => resume(Effect.succeed(code ?? -1)));
    });
    const interrupted =
      options.signal === undefined
        ? Effect.never
        : Effect.callback<never, OfficialPluginAdapterError>((resume) => {
            const abortHandler = () =>
              resume(
                Effect.fail(
                  new OfficialPluginAdapterError(
                    "cancelled",
                    "The Codex plugin command was cancelled.",
                  ),
                ),
              );
            options.signal!.addEventListener("abort", abortHandler, { once: true });
            return Effect.sync(() => options.signal!.removeEventListener("abort", abortHandler));
          });
    const command = Effect.all(
      [
        collectChildStream(child.stdout, options.stdoutLimit),
        collectChildStream(child.stderr, options.stderrLimit),
        exit,
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.timeout(options.timeoutMs),
      Effect.mapError((error) =>
        error instanceof OfficialPluginAdapterError
          ? error
          : error !== null &&
              typeof error === "object" &&
              "_tag" in error &&
              error._tag === "TimeoutError"
            ? new OfficialPluginAdapterError("timeout", "The Codex plugin command timed out.")
            : new OfficialPluginAdapterError("command_failed", "The Codex plugin command failed."),
      ),
    );
    const [stdoutText, stderrText, exitCode] = yield* Effect.raceFirst(command, interrupted).pipe(
      Effect.onError(() => Effect.sync(() => child.kill())),
    );
    return { stdout: stdoutText, stderr: stderrText, exitCode };
  });
}

function collectChildStream(
  stream: NodeJS.ReadableStream | null,
  limit: number,
): Effect.Effect<string, OfficialPluginAdapterError> {
  if (stream === null) {
    return Effect.fail(
      new OfficialPluginAdapterError(
        "command_failed",
        "Codex plugin command output is unavailable.",
      ),
    );
  }
  return Effect.callback<string, OfficialPluginAdapterError>((resume) => {
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
        resume(
          Effect.fail(
            new OfficialPluginAdapterError("command_failed", "Codex plugin output was invalid."),
          ),
        );
        return;
      }
      size += bytes.byteLength;
      if (size > limit) {
        resume(
          Effect.fail(
            new OfficialPluginAdapterError(
              "output_limit",
              "Codex plugin output exceeded its limit.",
            ),
          ),
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
      resume(
        Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(output),
          catch: () =>
            new OfficialPluginAdapterError(
              "command_failed",
              "Codex plugin output was not valid UTF-8.",
            ),
        }),
      );
    });
    stream.once("error", () =>
      resume(
        Effect.fail(
          new OfficialPluginAdapterError(
            "command_failed",
            "Codex plugin output could not be read.",
          ),
        ),
      ),
    );
  });
}
