// SPDX-License-Identifier: Apache-2.0

import {
  CAPABILITY_REGISTRY,
  OPTIONAL_CAPABILITY_NAMES,
  STATE_SCHEMA_EPOCH,
  canonicalJson,
  lookupPlan,
  pluginIdsForOptionalCapabilities,
  resolveOptionalCapabilitySelections,
  type JsonObject,
  type PlanName,
  type ServiceTier,
} from "@holycodex/core";
import { readCanonicalBaseVersion } from "./manifest.ts";
import {
  resolveInstallerPaths,
  ensureOwnedDirectory,
  type ResolvedInstallerPaths,
} from "./paths.ts";
import { optionalJsonFile, writeAtomicJson } from "./storage.ts";
import { asJsonValue } from "./json.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import { decodeSchema, InstallRecordSchema } from "./schema.ts";
import { installNativeAgents } from "./native-agents.ts";
import type {
  Autonomy,
  CapabilityInstallState,
  CapabilityStateRecord,
  ExplicitOptionalSelections,
  InstallRecord,
  InstallResult,
  InstallerOptions,
  OptionalSelections,
  OfficialPluginManager,
} from "./types.ts";

export {
  CapabilityInstallStateSchema,
  CapabilityStateRecordSchema,
  InstallRecordSchema,
} from "./schema.ts";

export const HOLYCODEX_MARKETPLACE = "davidbasilefilho/holycodex";
export const HOLYCODEX_PLUGIN = "holycodex@holycodex";
export const DEFAULT_MODE_USER_INPUT_FEATURE = "default_mode_request_user_input";

export interface InstallRequest {
  readonly plan?: PlanName | undefined;
  readonly tier?: ServiceTier | undefined;
  readonly optional?: ExplicitOptionalSelections | undefined;
  readonly officialPlugins?: readonly string[] | undefined;
  readonly autonomy?: Autonomy | undefined;
  readonly maxSubagents?: number | undefined;
}

export async function installHolyCodex(
  request: InstallRequest = {},
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallResult> {
  const paths = resolveInstallerPaths(options, environment);
  await ensureOwnedDirectory(paths.stateRoot);
  const previous = await readActiveInstallRecord(paths);
  const plan = choosePlan(request.plan, previous?.plan);
  const tier = request.tier ?? previous?.tier ?? "Standard";
  const optional = chooseOptional(request.optional, previous?.optional_selections);
  const explicitOptional = request.optional ?? previous?.explicit_optional_selections ?? {};
  const autonomy = request.autonomy ?? previous?.autonomy ?? "assisted";
  const maxSubagents = chooseMaxSubagents(request.maxSubagents, previous?.max_subagents, plan);
  const providerPlugins = pluginIdsForOptionalCapabilities(
    optional,
    request.officialPlugins ?? (request.optional === undefined ? previous?.official_plugins : []),
  );
  const manager =
    options.officialPluginManager ?? (await CodexOfficialPluginManager.discover(environment));
  if (
    !manager.addMarketplace ||
    !manager.add ||
    !manager.list ||
    !manager.enableFeature ||
    !manager.featureEnabled
  ) {
    throw new InstallerError(
      "install_failed",
      "Native Codex plugin installation and verification are unavailable.",
    );
  }

  try {
    await manager.addMarketplace(HOLYCODEX_MARKETPLACE);
    await installAndVerify({ list: () => manager.list!(), add: (id) => manager.add!(id) }, [
      HOLYCODEX_PLUGIN,
      ...providerPlugins,
    ]);
    await manager.enableFeature(DEFAULT_MODE_USER_INPUT_FEATURE);
    if (!(await manager.featureEnabled(DEFAULT_MODE_USER_INPUT_FEATURE))) {
      throw new Error("Codex did not expose request_user_input in Default mode after setup");
    }
    await installNativeAgents(paths.codexHome, plan);
  } catch (error: unknown) {
    throw new InstallerError(
      "capability_denied",
      `Codex native plugin installation did not converge: ${safeMessage(error)}`,
      error,
      { recovery: "Retry install; Codex owns plugin installation state." },
    );
  }

  const capabilityState = capabilityStateFor(optional);
  const version = await readCanonicalBaseVersion();
  const installedAt = (options.now?.() ?? new Date()).toISOString();
  const digest = await settingsDigest({
    version,
    plan,
    tier,
    optional_selections: optional,
    explicit_optional_selections: explicitOptional,
    official_plugins: providerPlugins,
    capability_state: capabilityState,
    autonomy,
    max_subagents: maxSubagents,
  });
  const record: InstallRecord = {
    schema_epoch: STATE_SCHEMA_EPOCH,
    version,
    digest,
    plan,
    tier,
    optional_selections: optional,
    explicit_optional_selections: explicitOptional,
    official_plugins: providerPlugins,
    capability_state: capabilityState,
    autonomy,
    max_subagents: maxSubagents,
    installed_at: installedAt,
  };
  if (decodeSchema(InstallRecordSchema, record) === undefined) {
    throw new InstallerError("state_corrupt", "The HolyCodex configuration is invalid.");
  }
  await writeAtomicJson(paths.activeRecord, asJsonValue(record));
  return { record, recovered_lock: false, optional_plugins: providerPlugins };
}

export async function readActiveInstallRecord(
  paths: ResolvedInstallerPaths,
): Promise<InstallRecord | undefined> {
  return await optionalJsonFile(paths.activeRecord, InstallRecordSchema);
}

async function installAndVerify(
  manager: Required<Pick<OfficialPluginManager, "list" | "add">>,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    const before = findPlugin(await manager.list(), id);
    if (!(before?.installed && before.enabled)) await manager.add(id);
    const after = findPlugin(await manager.list(), id);
    if (!after?.installed || !after.enabled) {
      throw new Error(`${id} is ${after?.installed ? "disabled" : "not installed"} after add`);
    }
  }
}

function findPlugin(
  live: Awaited<ReturnType<NonNullable<OfficialPluginManager["list"]>>>,
  id: string,
) {
  return [...live.installed, ...live.available].find((entry) => entry.pluginId === id);
}

function choosePlan(requested: PlanName | undefined, previous: PlanName | undefined): PlanName {
  const value = requested ?? previous ?? "plus";
  if (!lookupPlan(value).ok) throw new InstallerError("install_failed", "Unknown plan.");
  return value;
}

function chooseOptional(
  requested: ExplicitOptionalSelections | undefined,
  previous: OptionalSelections | undefined,
): OptionalSelections {
  return { ...resolveOptionalCapabilitySelections(requested, previous), coding: true };
}

function chooseMaxSubagents(
  requested: number | undefined,
  previous: number | undefined,
  plan: PlanName,
): number {
  const selected = lookupPlan(plan);
  const maximum = selected.ok ? (selected.value.budget?.maxConcurrency ?? 1) : 1;
  const value = requested ?? previous ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new InstallerError(
      "install_failed",
      `max-subagents must be an integer from 1 to ${maximum} for plan ${plan}.`,
    );
  }
  return value;
}

function capabilityStateFor(selections: OptionalSelections): CapabilityStateRecord {
  return Object.fromEntries(
    OPTIONAL_CAPABILITY_NAMES.map((name) => {
      const selected = selections[name];
      const value: CapabilityInstallState = {
        selected,
        status: selected ? "healthy" : "disabled",
        plugin_ids: [...CAPABILITY_REGISTRY[name].pluginIds],
      };
      return [name, value];
    }),
  ) as unknown as CapabilityStateRecord;
}

async function settingsDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(asJsonValue(value))),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "operation failed";
}

export class InstallerError extends Error {
  readonly code: "install_failed" | "capability_denied" | "permission_denied" | "state_corrupt";
  readonly causeValue: unknown;
  readonly details: JsonObject;

  constructor(
    code: InstallerError["code"],
    message: string,
    causeValue?: unknown,
    details: JsonObject = {},
  ) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
    this.causeValue = causeValue;
    this.details = details;
  }
}
