// SPDX-License-Identifier: Apache-2.0

import { assemblePayload, pluginSourceRoot, verifyPayload } from "@holycodex/plugin";
import { OfficialPluginSelectionSchema, selectOfficialPlugins } from "@holycodex/codex";
import {
  lookupPlan,
  type PlanName,
  type ServiceTier,
  STATE_SCHEMA_EPOCH,
  canonicalJson,
} from "@holycodex/core";
import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { acquireInstallLock, type LockLease } from "./lock.ts";
import {
  findManagedEntry,
  managedEntryMatches,
  marketplaceWithManagedEntry,
  readMarketplace,
  writeMarketplace,
} from "./marketplace.ts";
import { readCanonicalVersion } from "./manifest.ts";
import {
  assertNoSymlink,
  assertNoSymlinkTree,
  ensureOwnedDirectory,
  isFsCode,
  pathWithin,
  resolveInstallerPaths,
  type ResolvedInstallerPaths,
} from "./paths.ts";
import {
  optionalJsonFile,
  readJsonFile,
  syncFile,
  syncDirectory,
  writeAtomicJson,
} from "./storage.ts";
import { asJsonValue } from "./json.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import { migrateLegacyState, readMigratedInstallerSelections } from "./migration.ts";
import {
  ArtifactIdSchema,
  decodeSchema,
  InstallJournalRecordSchema,
  InstallRecordSchema,
} from "./schema.ts";
import type {
  Autonomy,
  ExplicitOptionalSelections,
  InstallRecord,
  InstallResult,
  InstallerOptions,
  OptionalSelections,
} from "./types.ts";
import type { JsonObject } from "@holycodex/core";

export { InstallJournalRecordSchema, InstallRecordSchema } from "./schema.ts";

export interface InstallRequest {
  readonly plan?: PlanName | undefined;
  readonly tier?: ServiceTier | undefined;
  readonly optional?: ExplicitOptionalSelections | undefined;
  readonly officialPlugins?: readonly string[] | undefined;
  readonly autonomy?: Autonomy | undefined;
  readonly maxSubagents?: number | undefined;
}

type JournalRecord = typeof InstallJournalRecordSchema.Type;

export async function installHolyCodex(
  request: InstallRequest = {},
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallResult> {
  const paths = resolveInstallerPaths(options, environment);
  await validateRoots(paths);
  await ensureOwnedDirectory(paths.stateRoot);
  const now = options.now ?? (() => new Date());
  const runId = options.runIdFactory?.() ?? `install-${crypto.randomUUID()}`;
  let lease: LockLease | undefined;
  try {
    lease = await acquireInstallLock(
      paths,
      {
        ttlMs: options.lockTtlMs ?? 5 * 60 * 1000,
        pid: options.pid ?? process.pid,
        runId,
        now,
      },
      async (details) => appendJournal(paths, runId, "lock-recovery", details, now),
    );
    const migration = await migrateLegacyState(paths, now);
    if (migration.status === "quarantined") {
      throw new InstallerError(
        "state_corrupt",
        "Legacy state was retained as incompatible historical data.",
      );
    }
    const previous = await readPreviousRecord(paths);
    const migrated = await readMigratedInstallerSelections(paths);
    const manifestVersion = await readCanonicalVersion();
    const plan = choosePlan(request.plan, previous?.plan ?? migrated?.plan);
    const tier = chooseTier(request.tier, previous?.tier ?? migrated?.tier);
    const optional = chooseOptional(
      request.optional,
      previous?.optional_selections ??
        (migrated ? { ...migrated.optional, coding: true } : undefined),
    );
    const autonomy = chooseAutonomy(request.autonomy, previous?.autonomy ?? migrated?.autonomy);
    const maxSubagents = chooseMaxSubagents(
      request.maxSubagents,
      previous?.max_subagents ?? migrated?.max_subagents,
      plan,
    );
    const explicitOptional = request.optional ?? previous?.explicit_optional_selections ?? {};
    const bundledAssets = join(dirname(fileURLToPath(import.meta.url)), "assets");
    const sourceRoot =
      options.sourceRoot ?? ((await isDirectory(bundledAssets)) ? bundledAssets : pluginSourceRoot);
    const staged = await stagePayload(paths, sourceRoot, manifestVersion, runId);
    const identity = staged.identity;
    const artifactId = `artifact-${identity.digest}-${identity.epoch}`;
    const artifactPath = join(paths.payloadRoot, artifactId);
    await activateArtifact(
      staged.stagingDirectory,
      artifactPath,
      identity.digest,
      identity.version,
      identity.epoch,
    );
    const record: InstallRecord = {
      schema_epoch: STATE_SCHEMA_EPOCH,
      version: identity.version,
      digest: identity.digest,
      epoch: identity.epoch,
      artifact_id: artifactId,
      relative_path: `./plugins/holycodex/${artifactId}`,
      plan,
      tier,
      optional_selections: optional,
      explicit_optional_selections: explicitOptional,
      official_plugins: request.officialPlugins ?? previous?.official_plugins ?? [],
      autonomy,
      max_subagents: maxSubagents,
      installed_at: now().toISOString(),
    };
    const parsedRecord = decodeSchema(InstallRecordSchema, record);
    if (parsedRecord === undefined) {
      throw new InstallerError("install_failed", "The active install record is invalid.");
    }
    await appendJournal(
      paths,
      runId,
      "artifact-ready",
      { artifact_id: artifactId, digest: identity.digest },
      now,
    );
    const previousActiveBytes = await readOptionalBytes(paths.activeRecord);
    const previousMarketplaceBytes = await readOptionalBytes(paths.marketplaceFile);
    try {
      await writeAtomicJson(paths.activeRecord, asJsonValue(record));
      await appendJournal(paths, runId, "active-written", { artifact_id: artifactId }, now);
      const marketplace = await readMarketplace(paths.marketplaceFile);
      const nextMarketplace = marketplaceWithManagedEntry(marketplace, record);
      await writeMarketplace(paths.marketplaceFile, nextMarketplace);
      await appendJournal(paths, runId, "marketplace-written", { artifact_id: artifactId }, now);
      await verifyActivation(paths, record);
      await appendJournal(paths, runId, "activation-verified", { artifact_id: artifactId }, now);
    } catch (error: unknown) {
      await rollbackFile(paths.activeRecord, previousActiveBytes);
      await rollbackFile(paths.marketplaceFile, previousMarketplaceBytes);
      await appendJournal(paths, runId, "rollback", { reason: safeMessage(error) }, now).catch(
        () => undefined,
      );
      throw new InstallerError(
        "install_failed",
        "The install pointers could not be committed.",
        error,
      );
    }
    const selectedOfficialPlugins = request.officialPlugins ?? [];
    if (selectedOfficialPlugins.length > 0) {
      let manager = options.officialPluginManager;
      try {
        if (!manager) {
          manager = await CodexOfficialPluginManager.discover();
        }
        await installSelectedOfficialPlugins(selectedOfficialPlugins, manager);
        await appendJournal(
          paths,
          runId,
          "official-plugins-applied",
          { count: selectedOfficialPlugins.length },
          now,
        );
      } catch (error: unknown) {
        await appendJournal(
          paths,
          runId,
          "official-plugins-uncertain",
          { count: selectedOfficialPlugins.length },
          now,
        ).catch(() => undefined);
        throw new InstallerError(
          "capability_denied",
          "The core install is active, but official plugin state is uncertain.",
          error,
        );
      }
    }
    const prunedArtifacts = await pruneInactiveArtifacts(paths, artifactId);
    await appendJournal(paths, runId, "pruned", { count: prunedArtifacts.length }, now);
    return {
      record,
      artifact_path: artifactPath,
      marketplace_path: paths.marketplaceFile,
      recovered_lock: lease.recovered,
      pruned_artifacts: prunedArtifacts,
      optional_plugins: [...(record.official_plugins ?? [])],
    };
  } finally {
    await lease?.release();
  }
}

export async function readActiveInstallRecord(
  paths: ResolvedInstallerPaths,
): Promise<InstallRecord | undefined> {
  return await optionalJsonFile(paths.activeRecord, InstallRecordSchema);
}

export async function verifyActivation(
  paths: ResolvedInstallerPaths,
  record: InstallRecord,
): Promise<void> {
  const active = await readJsonFile(paths.activeRecord, InstallRecordSchema);
  if (canonicalJson(active) !== canonicalJson(record)) {
    throw new InstallerError(
      "install_failed",
      "The active install record changed during activation.",
    );
  }
  const artifact = join(paths.marketplaceRoot, record.relative_path.slice(2));
  if (!pathWithin(paths.payloadRoot, artifact)) {
    throw new InstallerError("install_failed", "The active payload path escaped the owned root.");
  }
  const verified = await verifyPayload(artifact);
  if (
    verified.identity.digest !== record.digest ||
    verified.identity.version !== record.version ||
    verified.identity.epoch !== record.epoch
  ) {
    throw new InstallerError("install_failed", "The active payload identity does not match state.");
  }
  const marketplace = await readMarketplace(paths.marketplaceFile);
  const entry = findManagedEntry(marketplace);
  if (!managedEntryMatches(entry, record)) {
    throw new InstallerError(
      "install_failed",
      "The marketplace entry does not match active state.",
    );
  }
}

async function validateRoots(paths: ResolvedInstallerPaths): Promise<void> {
  await ensureOwnedDirectory(paths.codexHome);
  await ensureOwnedDirectory(paths.marketplaceRoot);
  await assertNoSymlinkTree(paths.codexHome);
  await assertNoSymlinkTree(paths.marketplaceRoot);
  if (paths.codexHome === paths.marketplaceRoot) {
    throw new InstallerError("install_failed", "The installer roots alias each other.");
  }
}

async function readPreviousRecord(
  paths: ResolvedInstallerPaths,
): Promise<InstallRecord | undefined> {
  return await readActiveInstallRecord(paths);
}

function choosePlan(requested: PlanName | undefined, previous: PlanName | undefined): PlanName {
  const value = requested ?? previous ?? "plus";
  const result = lookupPlan(value);
  if (!result.ok) {
    throw new InstallerError("install_failed", "The install plan is unavailable.");
  }
  return result.value.name;
}

function chooseTier(
  requested: ServiceTier | undefined,
  previous: ServiceTier | undefined,
): ServiceTier {
  return requested ?? previous ?? "Standard";
}

function chooseOptional(
  requested: ExplicitOptionalSelections | undefined,
  previous: OptionalSelections | undefined,
): OptionalSelections {
  return {
    computer_use: requested?.computer_use ?? previous?.computer_use ?? false,
    work: requested?.work ?? previous?.work ?? false,
    web: requested?.web ?? previous?.web ?? false,
    security: requested?.security ?? previous?.security ?? false,
    coding: true,
  };
}

function chooseAutonomy(requested: Autonomy | undefined, previous: Autonomy | undefined): Autonomy {
  return requested ?? previous ?? "assisted";
}

function chooseMaxSubagents(
  requested: number | undefined,
  previous: number | undefined,
  plan: PlanName,
): number {
  const planResult = lookupPlan(plan);
  if (!planResult.ok) {
    throw new InstallerError("install_failed", "The install plan is unavailable.");
  }
  const maximum = planResult.value.budget?.maxConcurrency ?? 1;
  const value = requested ?? previous ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new InstallerError("install_failed", "The maximum specialist count is not admitted.");
  }
  return value;
}

async function stagePayload(
  paths: ResolvedInstallerPaths,
  sourceRoot: string,
  version: string,
  runId: string,
): Promise<
  Readonly<{
    stagingDirectory: string;
    identity: Readonly<{ digest: string; version: string; epoch: string }>;
  }>
> {
  await ensureOwnedDirectory(paths.payloadRoot);
  await ensureOwnedDirectory(paths.stagingRoot);
  const stagingDirectory = await mkdtemp(join(paths.stagingRoot, `${runId}-`));
  try {
    await assemblePayload({ sourceRoot, stagingDirectory, version });
    const verified = await verifyPayload(stagingDirectory);
    return { stagingDirectory, identity: verified.identity };
  } catch (error: unknown) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw new InstallerError("install_failed", "The plugin payload could not be assembled.", error);
  }
}

async function activateArtifact(
  stagingDirectory: string,
  artifactPath: string,
  digest: string,
  version: string,
  epoch: string,
): Promise<void> {
  await assertNoSymlinkTree(stagingDirectory);
  try {
    const existing = await stat(artifactPath);
    if (!existing.isDirectory()) {
      throw new InstallerError("install_failed", "An immutable artifact path is occupied.");
    }
    await assertNoSymlink(artifactPath);
    const verified = await verifyPayload(artifactPath);
    if (
      verified.identity.digest !== digest ||
      verified.identity.version !== version ||
      verified.identity.epoch !== epoch
    ) {
      throw new InstallerError(
        "install_failed",
        "An immutable artifact identity collision was detected.",
      );
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    return;
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      throw error;
    }
    if (!isFsCode(error, "ENOENT")) {
      throw error;
    }
  }
  await rename(stagingDirectory, artifactPath);
  await syncDirectory(dirname(artifactPath));
}

async function installSelectedOfficialPlugins(
  ids: readonly string[],
  manager: NonNullable<InstallerOptions["officialPluginManager"]>,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  if (!manager.list || !manager.add) {
    throw new InstallerError("capability_denied", "Official plugin selection is unavailable.");
  }
  const selections = ids.map((id) => {
    const parsed = decodeSchema(OfficialPluginSelectionSchema, { id, selected: true });
    if (parsed === undefined) {
      throw new InstallerError("install_failed", "An official plugin selection is invalid.");
    }
    return parsed;
  });
  const selected = selectOfficialPlugins(await manager.list(), selections);
  for (const plugin of selected) {
    await manager.add(plugin);
  }
}

async function pruneInactiveArtifacts(
  paths: ResolvedInstallerPaths,
  activeArtifactId: string,
): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(paths.payloadRoot);
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const removed: string[] = [];
  for (const entry of [...entries].sort()) {
    if (entry === activeArtifactId || decodeSchema(ArtifactIdSchema, entry) === undefined) {
      continue;
    }
    const candidate = join(paths.payloadRoot, entry);
    await assertNoSymlink(candidate);
    try {
      const verified = await verifyPayload(candidate);
      if (verified.identity.digest !== entry.slice("artifact-".length, "artifact-".length + 64)) {
        continue;
      }
      await rm(candidate, { recursive: true, force: false });
      removed.push(entry);
    } catch {
      continue;
    }
  }
  return removed;
}

export async function appendJournal(
  paths: ResolvedInstallerPaths,
  runId: string,
  phase:
    | "lock-recovery"
    | "artifact-ready"
    | "active-written"
    | "marketplace-written"
    | "activation-verified"
    | "official-plugins-applied"
    | "official-plugins-uncertain"
    | "rollback"
    | "pruned",
  details: Readonly<Record<string, string | number>>,
  now: () => Date,
): Promise<void> {
  await ensureOwnedDirectory(paths.stateRoot);
  let sequence = 1;
  try {
    const existing = await readFile(paths.journal, "utf8");
    for (const line of existing.split("\n")) {
      if (line.trim().length === 0) continue;
      const parsed: unknown = JSON.parse(line);
      const record = decodeSchema(InstallJournalRecordSchema, parsed);
      if (record === undefined || record.sequence !== sequence) {
        throw new InstallerError("state_corrupt", "The installer journal sequence is invalid.");
      }
      sequence += 1;
    }
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) {
      throw error;
    }
  }
  const record: JournalRecord = {
    phase,
    at: now().toISOString(),
    run_id: runId,
    sequence,
    details: { ...details },
  };
  const parsed = decodeSchema(InstallJournalRecordSchema, record);
  if (parsed === undefined) {
    throw new InstallerError("state_corrupt", "The installer journal record is invalid.");
  }
  await writeFile(paths.journal, `${canonicalJson(parsed)}\n`, { flag: "a", mode: 0o600 });
  await syncFile(paths.journal);
}

async function readOptionalBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    await assertNoSymlink(path);
    return await readFile(path);
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const entry = await stat(path).catch(() => undefined);
  return entry?.isDirectory() === true;
}

async function rollbackFile(path: string, bytes: Uint8Array | undefined): Promise<void> {
  await assertNoSymlink(path);
  if (bytes === undefined) {
    await unlink(path).catch((error: unknown) => {
      if (!isFsCode(error, "ENOENT")) {
        throw error;
      }
    });
    return;
  }
  await writeFile(path, bytes, { mode: 0o600 });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "operation failed";
}

export class InstallerError extends Error {
  readonly code: "install_failed" | "capability_denied" | "permission_denied" | "state_corrupt";
  readonly causeValue: unknown;
  readonly details: JsonObject;

  constructor(
    code: "install_failed" | "capability_denied" | "permission_denied" | "state_corrupt",
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
