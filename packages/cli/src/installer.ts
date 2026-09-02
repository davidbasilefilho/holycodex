// SPDX-License-Identifier: Apache-2.0

import {
  CAPABILITY_REGISTRY,
  STATE_SCHEMA_EPOCH,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  lookupPlan,
  pluginIdsForOptionalCapabilities,
  ServiceTierSchema,
  type JsonObject,
  type OptionalCapabilitySelections,
  type PlanName,
  type ServiceTier,
} from "@holycodex/core";
import { readCanonicalBaseVersion } from "./manifest.ts";
import {
  ensureOwnedDirectory,
  resolveInstallerPaths,
  PathBoundaryError,
  type ResolvedInstallerPaths,
} from "./paths.ts";
import { optionalJsonFile, writeAtomicJson } from "./storage.ts";
import { asJsonValue } from "./json.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import { decodeSchema, InstallRecordSchema, InstallRequestSchema } from "./schema.ts";
import {
  installNativeAgents,
  removeManagedNativeAgents,
  type NativeAgentInstallResult,
} from "./native-agents.ts";
import type {
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
  InstallRequestSchema,
  InstallRecordSchema,
} from "./schema.ts";

export const HOLYCODEX_MARKETPLACE = "davidbasilefilho/holycodex";
export const HOLYCODEX_PLUGIN = "holycodex@holycodex";

export interface InstallRequest {
  readonly plan?: PlanName | undefined;
  readonly tier?: ServiceTier | undefined;
  readonly optional?: ExplicitOptionalSelections | undefined;
  readonly officialPlugins?: readonly string[] | undefined;
}

export async function installHolyCodex(
  request: InstallRequest = {},
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallResult> {
  if (decodeSchema(InstallRequestSchema, request) === undefined) {
    throw new InstallerError("install_failed", "The installation options are invalid.");
  }
  const paths = resolveInstallerPaths(options, environment);
  await ensureOwnedDirectory(paths.stateRoot);
  const previous = await readActiveInstallRecord(paths);
  if (previous !== undefined && !(await recordDigestMatches(previous))) {
    throw new InstallerError(
      "state_corrupt",
      "The existing HolyCodex configuration has changed and cannot be replaced.",
      undefined,
      { path: paths.activeRecord },
    );
  }
  const plan = choosePlan(request.plan, previous?.plan);
  const tier = chooseTier(request.tier, previous?.tier);
  const optional = chooseOptional(request.optional, previous?.optional_selections);
  const explicitOptional = request.optional ?? previous?.explicit_optional_selections ?? {};
  const providerPlugins = pluginIdsForOptionalCapabilities(
    toCoreSelections(optional),
    request.officialPlugins ?? previous?.official_plugins ?? [],
  );
  let manager: OfficialPluginManager;
  try {
    manager =
      options.officialPluginManager ??
      (await CodexOfficialPluginManager.discover({
        ...environment,
        CODEX_HOME: paths.codexHome,
      }));
  } catch (error: unknown) {
    throw new InstallerError(
      "capability_denied",
      "Native Codex plugin installation is unavailable.",
      error,
      { recovery: "Install or expose Codex, then retry." },
    );
  }
  if (!manager.addMarketplace || !manager.add || !manager.list) {
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
  } catch (error: unknown) {
    throw new InstallerError(
      "capability_denied",
      `Codex native plugin installation did not converge: ${safeMessage(error)}`,
      error,
      { recovery: "Retry install; Codex owns plugin installation state." },
    );
  }

  const installId = previous?.install_id ?? crypto.randomUUID().replaceAll("-", "");
  let native: NativeAgentInstallResult;
  try {
    native = await installNativeAgents(paths.codexHome, plan, previous?.managed_artifacts, tier);
  } catch (error: unknown) {
    if (error instanceof PathBoundaryError) throw error;
    throw new InstallerError("install_failed", safeMessage(error), error);
  }
  const capabilityState = capabilityStateFor(optional);
  const version = await readCanonicalBaseVersion();
  const installedAt = (options.now?.() ?? new Date()).toISOString();
  const digest = await installRecordDigest({
    owner: "holycodex",
    install_id: installId,
    version,
    plan,
    tier,
    optional_selections: optional,
    explicit_optional_selections: explicitOptional,
    official_plugins: providerPlugins,
    capability_state: capabilityState,
    managed_artifacts: native.managed_artifacts,
  });
  const record: InstallRecord = {
    owner: "holycodex",
    schema_epoch: STATE_SCHEMA_EPOCH,
    install_id: installId,
    version,
    digest,
    plan,
    tier,
    optional_selections: optional,
    explicit_optional_selections: explicitOptional,
    official_plugins: providerPlugins,
    capability_state: capabilityState,
    managed_artifacts: native.managed_artifacts,
    installed_at: installedAt,
  };
  if (decodeSchema(InstallRecordSchema, record) === undefined) {
    throw new InstallerError("state_corrupt", "The HolyCodex configuration is invalid.");
  }
  await writeAtomicJson(paths.activeRecord, asJsonValue(record));
  return {
    record,
    optional_plugins: providerPlugins,
    preserved: native.preserved,
    warnings: native.preserved.length === 0 ? [] : ["modified managed files were preserved"],
  };
}

export async function readActiveInstallRecord(
  paths: ResolvedInstallerPaths,
): Promise<InstallRecord | undefined> {
  return await optionalJsonFile(paths.activeRecord, InstallRecordSchema);
}

export { removeManagedNativeAgents };

function toCoreSelections(value: OptionalSelections): OptionalCapabilitySelections {
  return {
    computer_use: value.computer_use,
    work: value.work,
    frontend: value.frontend,
    security: value.security,
  };
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

function chooseTier(
  requested: ServiceTier | undefined,
  previous: ServiceTier | undefined,
): ServiceTier {
  const value = requested ?? previous ?? "standard";
  if (decodeSchema(ServiceTierSchema, value) === undefined) {
    throw new InstallerError("install_failed", "The tier is not supported.");
  }
  return value;
}

function chooseOptional(
  requested: ExplicitOptionalSelections | undefined,
  previous: OptionalSelections | undefined,
): OptionalSelections {
  const fallback = previous ?? {
    computer_use: false,
    work: false,
    frontend: true,
    security: true,
    coding: true,
  };
  return {
    computer_use: requested?.computer_use ?? fallback.computer_use,
    work: requested?.work ?? fallback.work,
    frontend: requested?.frontend ?? fallback.frontend,
    security: requested?.security ?? fallback.security,
    coding: true,
  };
}

function capabilityStateFor(selections: OptionalSelections): CapabilityStateRecord {
  const names = ["computer_use", "work", "frontend", "security"] as const;
  return Object.fromEntries(
    names.map((name) => {
      const selected = selections[name];
      const value: CapabilityInstallState = {
        selected,
        status: selected ? "healthy" : "disabled",
        plugin_ids: [...CAPABILITY_REGISTRY[name].pluginIds],
      };
      return [name, value];
    }),
  ) as CapabilityStateRecord;
}

type InstallRecordDigestInput = Omit<
  Pick<
    InstallRecord,
    | "owner"
    | "install_id"
    | "version"
    | "plan"
    | "tier"
    | "optional_selections"
    | "explicit_optional_selections"
    | "official_plugins"
    | "capability_state"
    | "managed_artifacts"
  >,
  "official_plugins" | "capability_state"
> & {
  readonly official_plugins: readonly string[];
  readonly capability_state: CapabilityStateRecord | null;
};

export async function installRecordDigest(value: InstallRecordDigestInput): Promise<string> {
  return await domainSeparatedSha256("install-record", [canonicalJsonUtf8(asJsonValue(value))]);
}

export async function recordDigestMatches(record: InstallRecord): Promise<boolean> {
  const digest = await installRecordDigest({
    owner: record.owner,
    install_id: record.install_id,
    version: record.version,
    plan: record.plan,
    tier: record.tier,
    optional_selections: record.optional_selections,
    explicit_optional_selections: record.explicit_optional_selections,
    official_plugins: record.official_plugins ?? [],
    capability_state: record.capability_state ?? null,
    managed_artifacts: record.managed_artifacts,
  });
  return digest === record.digest;
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
