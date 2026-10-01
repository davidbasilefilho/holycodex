// SPDX-License-Identifier: Apache-2.0

import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createAllowlistedEnvironment,
  createOfficialPluginAdapter,
  discoverCodexExecutable,
  OfficialPluginAdapterError,
  resolveOfficialPluginEntry,
  TomlDocumentSchema,
  type LiveOfficialPluginEntry,
  type LiveOfficialPluginListEnvelope,
  type OfficialPluginCommandRunner,
} from "@holycodex/codex";
import { canonicalOfficialPluginId, officialPluginIdCandidates } from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OfficialPluginManager, OfficialPluginStatus } from "./types.ts";

export type { OfficialPluginCommandRunner } from "@holycodex/codex";

/** Official plugin manager backed by the Codex command-line interface. */
export class CodexOfficialPluginManager implements OfficialPluginManager {
  private readonly adapter: OfficialPluginAdapterShape;
  private observedIdentities: Readonly<Record<string, string>> = {};

  constructor(input: OfficialPluginCommandRunner | OfficialPluginAdapterShape) {
    if ("run" in input) {
      const adapter = createOfficialPluginAdapter({ executable: "codex", runner: input });
      this.adapter = adapter;
    } else {
      this.adapter = input;
    }
  }

  /** Discover a Codex executable and create an official plugin manager for it. */
  static discover(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): Promise<CodexOfficialPluginManager> {
    return Effect.runPromise(CodexOfficialPluginManager.discoverEffect(environment));
  }

  /** Discover Codex and construct its official plugin manager in Effect. */
  static discoverEffect(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): Effect.Effect<CodexOfficialPluginManager, unknown> {
    return Effect.map(
      Effect.tryPromise({
        try: () => discoverCodexExecutable({ environment }),
        catch: (error) => error,
      }),
      (executable) => {
        const adapter = createOfficialPluginAdapter({
          executable: executable.path,
          environment: createAllowlistedEnvironment(environment),
          onMarketplaceConflict: (message) => {
            console.warn(`HolyCodex warning: ${message}`);
          },
          ...(environment["CODEX_HOME"] === undefined
            ? {}
            : { codexHome: environment["CODEX_HOME"] }),
        });
        return new CodexOfficialPluginManager(adapter);
      },
    );
  }

  /** List installed and available official Codex plugins. */
  list(): Promise<LiveOfficialPluginListEnvelope> {
    return Effect.runPromise(this.listEffect());
  }

  /** List installed and available official Codex plugins in Effect. */
  listEffect(): Effect.Effect<LiveOfficialPluginListEnvelope, OfficialPluginManagerError> {
    return Effect.tryPromise({
      try: () => this.adapter.list(),
      catch: (error) => wrapManagerError("list", error),
    });
  }

  /** Add an official Codex plugin by its identifier. */
  add(pluginId: string): Promise<void> {
    return Effect.runPromise(this.addEffect(pluginId));
  }

  /** Add an official Codex plugin in Effect. */
  addEffect(pluginId: string): Effect.Effect<void, OfficialPluginManagerError> {
    return Effect.tryPromise({
      try: () => this.adapter.add(pluginId),
      catch: (error) => wrapManagerError("add", error, pluginId),
    });
  }

  /** Ensure Codex-owned provider marketplaces required by selected plugins are available. */
  ensureOfficialMarketplace(selectedPluginIds: readonly string[]): Promise<void> {
    return Effect.runPromise(this.ensureOfficialMarketplaceEffect(selectedPluginIds));
  }

  /** Ensure required Codex-owned provider marketplaces in Effect. */
  ensureOfficialMarketplaceEffect(
    selectedPluginIds: readonly string[],
  ): Effect.Effect<void, OfficialPluginManagerError> {
    const ensure = this.adapter.ensureOfficialMarketplace;
    if (ensure === undefined) return Effect.void;
    return Effect.tryPromise({
      try: () => ensure(selectedPluginIds),
      catch: (error) => wrapManagerError("bootstrap", error),
    });
  }

  /** Remove an official Codex plugin by its identifier. */
  remove(pluginId: string): Promise<void> {
    return Effect.runPromise(this.removeEffect(pluginId));
  }

  /** Remove an official Codex plugin in Effect. */
  removeEffect(pluginId: string): Effect.Effect<void, OfficialPluginManagerError> {
    return Effect.tryPromise({
      try: () => this.adapter.remove(pluginId),
      catch: (error) => wrapManagerError("remove", error, pluginId),
    });
  }

  /** Ensure the official marketplace is registered, refreshed, and verified by Codex readback. */
  addMarketplace(source: string): Promise<void> {
    return Effect.runPromise(this.addMarketplaceEffect(source));
  }

  /** Ensure an official marketplace through Codex in Effect. */
  addMarketplaceEffect(source: string): Effect.Effect<void, OfficialPluginManagerError> {
    return Effect.tryPromise({
      try: () => this.adapter.addMarketplace(source),
      catch: (error) => wrapManagerError("add", error, source),
    });
  }

  /** Resolve the installed state of selected official plugins. */
  status(selected: readonly string[]): Promise<Readonly<Record<string, OfficialPluginStatus>>> {
    return Effect.runPromise(this.statusEffect(selected));
  }

  /** Resolve selected official plugin states in Effect. */
  statusEffect(
    selected: readonly string[],
  ): Effect.Effect<Readonly<Record<string, OfficialPluginStatus>>, OfficialPluginManagerError> {
    const adapter = this.adapter;
    const effect = Effect.gen(function* () {
      const live = yield* Effect.tryPromise({
        try: () => adapter.list(),
        catch: (error) => wrapManagerError("list", error),
      });
      const observed: Record<string, string> = {};
      const byId = new Map<string, LiveOfficialPluginEntry>();
      for (const entry of [...live.installed, ...live.available]) {
        if (!byId.has(entry.pluginId) || entry.installed) byId.set(entry.pluginId, entry);
      }
      const entries = yield* Effect.all(
        selected.map((pluginId) =>
          Effect.sync(() => {
            const resolved = resolveOfficialPluginEntry(live, pluginId);
            const canonical = canonicalOfficialPluginId(pluginId);
            const exact = byId.get(pluginId);
            const entry =
              resolved?.entry ??
              (canonical === undefined || exact?.marketplaceName == null ? exact : undefined);
            if (entry !== undefined)
              observed[pluginId] = resolved?.entry.pluginId ?? entry.pluginId;
            const status: OfficialPluginStatus =
              entry === undefined
                ? "missing"
                : entry.installed && entry.enabled
                  ? "installed"
                  : entry.installed
                    ? "disabled"
                    : "missing";
            return [pluginId, status] as const;
          }),
        ),
      );
      return { observed, statuses: Object.fromEntries(entries) };
    });
    return Effect.map(effect, ({ observed, statuses }) => {
      this.observedIdentities = Object.freeze(observed);
      return statuses;
    });
  }

  /** Return the live plugin id observed for each canonical provider in the last status check. */
  getObservedIdentities(): Readonly<Record<string, string>> {
    return this.observedIdentities;
  }
}

/**
 * Observe enabled plugin configuration and its installed manifest without invoking Codex or
 * refreshing caches.
 */
export class ReadOnlyCodexPluginStatus implements Pick<
  OfficialPluginManager,
  "status" | "getObservedIdentities"
> {
  private observedIdentities: Readonly<Record<string, string>> = {};

  constructor(private readonly codexHome: string) {}

  /** Return the current configured status for selected plugin identities. */
  status(selected: readonly string[]): Promise<Readonly<Record<string, OfficialPluginStatus>>> {
    return Effect.runPromise(this.statusEffect(selected));
  }

  /** Resolve selected plugin states from local config and cache in Effect. */
  statusEffect(
    selected: readonly string[],
  ): Effect.Effect<Readonly<Record<string, OfficialPluginStatus>>, unknown> {
    const codexHome = this.codexHome;
    const effect = Effect.gen(function* () {
      const text = yield* Effect.catchIf(
        Effect.tryPromise({
          try: () => readFile(join(codexHome, "config.toml"), "utf8"),
          catch: (error) => error,
        }),
        isMissingPath,
        () => Effect.succeed(undefined),
      );
      if (text === undefined) {
        return {
          identities: {},
          statuses: Object.fromEntries(
            selected.map((pluginId) => [pluginId, "missing"] as const),
          ) as Readonly<Record<string, OfficialPluginStatus>>,
        };
      }
      const bun = (globalThis as { Bun?: { TOML?: { parse: (value: string) => unknown } } }).Bun;
      if (bun?.TOML?.parse === undefined)
        return yield* Effect.fail(new Error("A TOML parser is unavailable."));
      const toml = bun.TOML;
      const parsedToml = yield* Effect.try({
        try: () => toml.parse(text),
        catch: (error) => error,
      });
      const config = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(TomlDocumentSchema)(parsedToml),
        catch: () => new Error("Codex configuration is invalid."),
      });
      const pluginRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
      const pluginConfigSchema = Schema.Struct({ enabled: Schema.optional(Schema.Boolean) });
      const plugins = Schema.is(pluginRecordSchema)(config["plugins"])
        ? config["plugins"]
        : undefined;
      const identities: Record<string, string> = {};
      const statuses = yield* Effect.all(
        selected.map((pluginId) =>
          Effect.gen(function* () {
            const candidates = officialPluginIdCandidates(pluginId);
            const configuredIds = candidates.length > 0 ? candidates : [pluginId];
            const configured = configuredIds.flatMap((id) => {
              if (plugins === undefined || !Object.hasOwn(plugins, id)) return [];
              const value = plugins[id];
              return [
                {
                  id,
                  enabled: Schema.is(pluginConfigSchema)(value) ? value.enabled : undefined,
                },
              ];
            });
            if (configured.length === 0) return [pluginId, "missing"] as const;

            const enabled = configured.filter((entry) => entry.enabled === true);
            const cachedEnabled = yield* Effect.all(
              enabled.map((entry) => {
                const candidates = officialPluginIdCandidates(entry.id);
                const orderedCandidates = [
                  entry.id,
                  ...candidates.filter((candidate) => candidate !== entry.id),
                ];
                return Effect.map(
                  findInstalledPluginCacheIdentityEffect(codexHome, orderedCandidates),
                  (cachedIdentity) => ({
                    ...entry,
                    cachedIdentity,
                  }),
                );
              }),
            );
            const installed = cachedEnabled.find((entry) => entry.cachedIdentity !== undefined);
            const observed = installed?.cachedIdentity ?? enabled[0]?.id ?? configured[0]?.id;
            if (observed !== undefined) identities[pluginId] = observed;
            if (installed !== undefined) return [pluginId, "installed"] as const;
            if (enabled.length > 0) return [pluginId, "missing"] as const;
            if (configured.every((entry) => entry.enabled === false))
              return [pluginId, "disabled"] as const;
            return [pluginId, "unknown"] as const;
          }),
        ),
      );
      return {
        identities,
        statuses: Object.fromEntries(statuses) as Readonly<Record<string, OfficialPluginStatus>>,
      };
    });
    return Effect.map(effect, ({ identities, statuses }) => {
      this.observedIdentities = Object.freeze(identities);
      return statuses;
    });
  }

  /** Return the config identities matched during the last status read. */
  getObservedIdentities(): Readonly<Record<string, string>> {
    return this.observedIdentities;
  }
}

function findInstalledPluginCacheIdentityEffect(
  codexHome: string,
  pluginIds: readonly string[],
): Effect.Effect<string | undefined, unknown> {
  return Effect.gen(function* () {
    for (const pluginId of pluginIds) {
      const separator = pluginId.lastIndexOf("@");
      if (separator <= 0 || separator === pluginId.length - 1) continue;
      const pluginRoot = join(
        codexHome,
        "plugins",
        "cache",
        pluginId.slice(separator + 1),
        pluginId.slice(0, separator),
      );
      const versions = yield* Effect.catchIf(
        Effect.tryPromise({
          try: () => readdir(pluginRoot, { withFileTypes: true, encoding: "utf8" }),
          catch: (error) => error,
        }),
        isMissingPath,
        () => Effect.succeed(undefined),
      );
      if (versions === undefined) continue;
      for (const version of versions) {
        if (!version.isDirectory()) continue;
        const installed = yield* Effect.catchIf(
          Effect.as(
            Effect.tryPromise({
              try: () => access(join(pluginRoot, version.name, ".codex-plugin", "plugin.json")),
              catch: (error) => error,
            }),
            true,
          ),
          isMissingPath,
          () => Effect.succeed(false),
        );
        if (installed) return pluginId;
      }
    }
    return undefined;
  });
}

const MissingPathSchema = Schema.Struct({ code: Schema.Literals(["ENOENT"]) });

function isMissingPath(error: unknown): boolean {
  return Schema.is(MissingPathSchema)(error);
}

type OfficialPluginAdapterShape = Readonly<{
  readonly list: () => Promise<LiveOfficialPluginListEnvelope>;
  readonly ensureOfficialMarketplace?: (selectedPluginIds: readonly string[]) => Promise<void>;
  readonly addMarketplace: (source: string) => Promise<void>;
  readonly add: (pluginId: string) => Promise<void>;
  readonly remove: (pluginId: string) => Promise<void>;
}>;

function wrapManagerError(
  operation: "list" | "add" | "remove" | "bootstrap",
  error: unknown,
  pluginId?: string,
): OfficialPluginManagerError {
  if (error instanceof OfficialPluginManagerError) return error;
  const adapterError = error instanceof OfficialPluginAdapterError ? error : undefined;
  const adapterCode = adapterError?.code;
  const code =
    adapterCode === "timeout" ||
    adapterCode === "output_limit" ||
    adapterCode === "cancelled" ||
    adapterCode === "readback_mismatch" ||
    adapterCode === "plugin_disabled" ||
    adapterCode === "plugin_missing" ||
    adapterCode === "marketplace_invalid" ||
    adapterCode === "marketplace_timeout" ||
    adapterCode === "marketplace_unavailable"
      ? adapterCode
      : adapterCode === "command_failed"
        ? operation === "list"
          ? "list_failed"
          : operation === "remove"
            ? "remove_failed"
            : operation === "bootstrap"
              ? "marketplace_unavailable"
              : "add_failed"
        : operation === "list"
          ? "list_failed"
          : operation === "bootstrap"
            ? "marketplace_unavailable"
            : "add_failed";
  const message =
    error instanceof Error
      ? error.message
      : operation === "list"
        ? "Codex could not list official plugins."
        : operation === "remove"
          ? `Codex could not remove ${pluginId ?? "the selected official plugin"}.`
          : operation === "bootstrap"
            ? "Codex could not initialize the official marketplace."
            : `Codex could not add ${pluginId ?? "the selected official plugin"}.`;
  return new OfficialPluginManagerError(
    code,
    message,
    error,
    pluginId === undefined ? {} : { plugin_id: pluginId },
  );
}

/** Structured failure raised by the official plugin manager boundary. */
export class OfficialPluginManagerError extends Error {
  /** The code in official plugin adapter shape. */
  readonly code:
    | "list_failed"
    | "add_failed"
    | "remove_failed"
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
  /** The cause value in official plugin adapter shape. */
  readonly causeValue: unknown;
  /** The details in official plugin adapter shape. */
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: OfficialPluginManagerError["code"],
    message: string,
    causeValue?: unknown,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "OfficialPluginManagerError";
    this.code = code;
    this.causeValue = causeValue;
    this.details = details;
  }
}
