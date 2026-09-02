// SPDX-License-Identifier: Apache-2.0

import {
  createAllowlistedEnvironment,
  createOfficialPluginAdapter,
  discoverCodexExecutable,
  OfficialPluginAdapterError,
  type LiveOfficialPluginEntry,
  type LiveOfficialPluginListEnvelope,
  type OfficialPluginCommandRunner,
} from "@holycodex/codex";
import type { OfficialPluginManager, OfficialPluginStatus } from "./types.ts";

export type { OfficialPluginCommandRunner } from "@holycodex/codex";

export class CodexOfficialPluginManager implements OfficialPluginManager {
  private readonly adapter: OfficialPluginAdapterShape;

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
    const byId = new Map<string, LiveOfficialPluginEntry>();
    for (const entry of [...live.installed, ...live.available]) {
      if (!byId.has(entry.pluginId) || entry.installed) {
        byId.set(entry.pluginId, entry);
      }
    }
    return Object.fromEntries(
      selected.map((pluginId) => {
        const entry = byId.get(pluginId);
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
  }
}

type OfficialPluginAdapterShape = Readonly<{
  readonly list: () => Promise<LiveOfficialPluginListEnvelope>;
  readonly addMarketplace: (source: string) => Promise<void>;
  readonly add: (pluginId: string) => Promise<void>;
  readonly remove: (pluginId: string) => Promise<void>;
}>;

function wrapManagerError(
  operation: "list" | "add" | "remove",
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
    adapterCode === "plugin_missing"
      ? adapterCode
      : adapterCode === "command_failed"
        ? operation === "list"
          ? "list_failed"
          : operation === "remove"
            ? "remove_failed"
            : "add_failed"
        : operation === "list"
          ? "list_failed"
          : "add_failed";
  const message =
    error instanceof Error
      ? error.message
      : operation === "list"
        ? "Codex could not list official plugins."
        : operation === "remove"
          ? `Codex could not remove ${pluginId ?? "the selected official plugin"}.`
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
    | "plugin_missing";
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
