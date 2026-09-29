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
  type ResolvedOfficialPluginEntry,
  type LiveOfficialPluginEntry,
  type LiveOfficialPluginListEnvelope,
  type OfficialPluginCommandRunner,
} from "@holycodex/codex";
import { canonicalOfficialPluginId, officialPluginIdCandidates } from "@holycodex/core";

import { decodeSchema } from "./schema.ts";
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
  static async discover(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): Promise<CodexOfficialPluginManager> {
    const executable = await discoverCodexExecutable({ environment });
    const adapter = createOfficialPluginAdapter({
      executable: executable.path,
      environment: createAllowlistedEnvironment(environment),
      ...(environment["CODEX_HOME"] === undefined ? {} : { codexHome: environment["CODEX_HOME"] }),
    });
    return new CodexOfficialPluginManager(adapter);
  }

  /** List installed and available official Codex plugins. */
  async list(): Promise<LiveOfficialPluginListEnvelope> {
    try {
      return await this.adapter.list();
    } catch (error: unknown) {
      throw wrapManagerError("list", error);
    }
  }

  /** Add an official Codex plugin by its identifier. */
  async add(pluginId: string): Promise<void> {
    try {
      await this.adapter.add(pluginId);
    } catch (error: unknown) {
      throw wrapManagerError("add", error, pluginId);
    }
  }

  /** Ensure Codex-owned provider marketplaces required by selected plugins are available. */
  async ensureOfficialMarketplace(selectedPluginIds: readonly string[]): Promise<void> {
    if (this.adapter.ensureOfficialMarketplace === undefined) return;
    try {
      await this.adapter.ensureOfficialMarketplace(selectedPluginIds);
    } catch (error: unknown) {
      throw wrapManagerError("bootstrap", error);
    }
  }

  /** Remove an official Codex plugin by its identifier. */
  async remove(pluginId: string): Promise<void> {
    try {
      await this.adapter.remove(pluginId);
    } catch (error: unknown) {
      throw wrapManagerError("remove", error, pluginId);
    }
  }

  /** Ensure the official marketplace is registered, refreshed, and verified by Codex readback. */
  async addMarketplace(source: string): Promise<void> {
    try {
      await this.adapter.addMarketplace(source);
    } catch (error: unknown) {
      throw wrapManagerError("add", error, source);
    }
  }

  /** Resolve the installed state of selected official plugins. */
  async status(
    selected: readonly string[],
  ): Promise<Readonly<Record<string, OfficialPluginStatus>>> {
    const live = await this.list();
    const observed: Record<string, string> = {};
    const byId = new Map<string, LiveOfficialPluginEntry>();
    for (const entry of [...live.installed, ...live.available]) {
      if (!byId.has(entry.pluginId) || entry.installed) {
        byId.set(entry.pluginId, entry);
      }
    }
    const statuses = Object.fromEntries(
      await Promise.all(
        selected.map(async (pluginId) => {
          const resolved = resolveOfficialPluginEntry(live, pluginId);
          const canonical = canonicalOfficialPluginId(pluginId);
          const exact = byId.get(pluginId);
          const entry =
            resolved?.entry ??
            (canonical === undefined || exact?.marketplaceName == null ? exact : undefined);
          const identity: ResolvedOfficialPluginEntry | undefined = resolved;
          if (entry !== undefined) observed[pluginId] = identity?.entry.pluginId ?? entry.pluginId;
          const status: OfficialPluginStatus =
            entry === undefined
              ? "missing"
              : entry.installed && entry.enabled
                ? "installed"
                : entry.installed
                  ? "disabled"
                  : "missing";
          return [pluginId, status];
        }),
      ),
    );
    this.observedIdentities = Object.freeze(observed);
    return statuses;
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
  async status(
    selected: readonly string[],
  ): Promise<Readonly<Record<string, OfficialPluginStatus>>> {
    let text: string;
    try {
      text = await readFile(join(this.codexHome, "config.toml"), "utf8");
    } catch (error: unknown) {
      if (isMissingPath(error)) {
        this.observedIdentities = Object.freeze({});
        return Object.fromEntries(selected.map((pluginId) => [pluginId, "missing"]));
      }
      throw error;
    }
    const bun = (globalThis as { Bun?: { TOML?: { parse: (value: string) => unknown } } }).Bun;
    if (!bun?.TOML?.parse) throw new Error("A TOML parser is unavailable.");
    const config = decodeSchema(TomlDocumentSchema, bun.TOML.parse(text));
    if (config === undefined) throw new Error("Codex configuration is invalid.");
    const pluginValue = config["plugins"];
    const plugins: Readonly<Record<string, unknown>> | undefined =
      typeof pluginValue === "object" && pluginValue !== null && !Array.isArray(pluginValue)
        ? (pluginValue as Readonly<Record<string, unknown>>)
        : undefined;
    const identities: Record<string, string> = {};
    const statuses = Object.fromEntries(
      await Promise.all(
        selected.map(async (pluginId) => {
          const candidates = officialPluginIdCandidates(pluginId);
          const configuredIds = candidates.length > 0 ? candidates : [pluginId];
          const configured = configuredIds.flatMap((id) => {
            if (plugins === undefined || !Object.hasOwn(plugins, id)) return [];
            const value = plugins?.[id];
            const enabled =
              typeof value === "object" && value !== null && !Array.isArray(value)
                ? (value as Record<string, unknown>)["enabled"]
                : undefined;
            return [{ id, enabled }];
          });
          if (configured.length === 0) return [pluginId, "missing"];

          const enabled = configured.filter((entry) => entry.enabled === true);
          const cachedEnabled = await Promise.all(
            enabled.map(async (entry) => ({
              ...entry,
              cached: await hasInstalledPluginCache(this.codexHome, [entry.id]),
            })),
          );
          const installed = cachedEnabled.find((entry) => entry.cached);
          const observed = installed?.id ?? enabled[0]?.id ?? configured[0]?.id;
          if (observed !== undefined) identities[pluginId] = observed;
          if (installed !== undefined) return [pluginId, "installed"];
          if (enabled.length > 0) return [pluginId, "missing"];
          if (configured.every((entry) => entry.enabled === false)) return [pluginId, "disabled"];
          return [pluginId, "unknown"];
        }),
      ),
    ) as Readonly<Record<string, OfficialPluginStatus>>;
    this.observedIdentities = Object.freeze(identities);
    return statuses;
  }

  /** Return the config identities matched during the last status read. */
  getObservedIdentities(): Readonly<Record<string, string>> {
    return this.observedIdentities;
  }
}

async function hasInstalledPluginCache(
  codexHome: string,
  pluginIds: readonly string[],
): Promise<boolean> {
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
    try {
      const versions = await readdir(pluginRoot, { withFileTypes: true, encoding: "utf8" });
      for (const version of versions) {
        if (!version.isDirectory()) continue;
        try {
          await access(join(pluginRoot, version.name, ".codex-plugin", "plugin.json"));
          return true;
        } catch (error: unknown) {
          if (!isMissingPath(error)) throw error;
        }
      }
    } catch (error: unknown) {
      if (isMissingPath(error)) continue;
      throw error;
    }
  }
  return false;
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
