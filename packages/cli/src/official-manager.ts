// SPDX-License-Identifier: Apache-2.0

import {
  createAllowlistedEnvironment,
  createOfficialPluginAdapter,
  discoverCodexExecutable,
  OfficialPluginAdapterError,
  resolveOfficialPluginEntry,
  type ResolvedOfficialPluginEntry,
  type LiveOfficialPluginEntry,
  type LiveOfficialPluginListEnvelope,
  type OfficialPluginCommandRunner,
} from "@holycodex/codex";
import { canonicalOfficialPluginId } from "@holycodex/core";

import type { OfficialPluginManager, OfficialPluginStatus } from "./types.ts";

export type { OfficialPluginCommandRunner } from "@holycodex/codex";

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

  async list(): Promise<LiveOfficialPluginListEnvelope> {
    try {
      return await this.adapter.list();
    } catch (error: unknown) {
      throw wrapManagerError("list", error);
    }
  }

  async add(pluginId: string): Promise<void> {
    try {
      await this.adapter.add(pluginId);
    } catch (error: unknown) {
      throw wrapManagerError("add", error, pluginId);
    }
  }

  async ensureOfficialMarketplace(selectedPluginIds: readonly string[]): Promise<void> {
    if (this.adapter.ensureOfficialMarketplace === undefined) return;
    try {
      await this.adapter.ensureOfficialMarketplace(selectedPluginIds);
    } catch (error: unknown) {
      throw wrapManagerError("bootstrap", error);
    }
  }

  async remove(pluginId: string): Promise<void> {
    try {
      await this.adapter.remove(pluginId);
    } catch (error: unknown) {
      throw wrapManagerError("remove", error, pluginId);
    }
  }

  async addMarketplace(source: string): Promise<void> {
    try {
      await this.adapter.addMarketplace(source);
    } catch (error: unknown) {
      throw wrapManagerError("add", error, source);
    }
  }

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
      selected.map((pluginId) => {
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
    );
    this.observedIdentities = Object.freeze(observed);
    return statuses;
  }

  /** Return the live plugin id observed for each canonical provider in the last status check. */
  getObservedIdentities(): Readonly<Record<string, string>> {
    return this.observedIdentities;
  }
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

export class OfficialPluginManagerError extends Error {
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
  readonly causeValue: unknown;
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
