// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import {
  canonicalJson,
  domainSeparatedSha256,
  PlanNameSchema,
  STATE_SCHEMA_EPOCH,
  type JsonObject,
  type JsonValue,
  type PlanName,
  type ServiceTier,
} from "@holycodex/core";
import { copyFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedInstallerPaths } from "./paths.ts";
import { assertNoSymlink, assertNoSymlinkTree, ensureOwnedDirectory, isFsCode } from "./paths.ts";
import {
  AutonomySchema,
  DateTextSchema,
  decodeSchema,
  DigestSchema,
  JsonObjectSchema,
  JsonValueSchema,
} from "./schema.ts";
import { optionalJsonFile, readJsonObject, StorageError, writeAtomicJson } from "./storage.ts";
import { asJsonValue } from "./json.ts";
import { readSavedWorkflow, saveWorkflow, WorkflowStoreError } from "./workflow-store.ts";
import { replaceRefinement } from "./refinement-store.ts";
import {
  ContinuationClaimSchema,
  FileRunStore,
  JournalEventSchema,
  RefinementSchema,
  RunSnapshotSchema,
  WorkflowHostError,
  decodeHostSchema,
  type JournalEvent,
  type RunSnapshot,
} from "@holycodex/workflow-host";

export const LEGACY_SCHEMA_EPOCH = "legacy-state-1" as const;
export const MIGRATION_RECORD_NAME = "migration.json" as const;
export const MIGRATED_STATE_NAME = "migrated-state.json" as const;

const LegacyRecordSchema = Schema.Struct({
  schema_epoch: Schema.optional(Schema.String),
  plan: Schema.optional(PlanNameSchema),
  tier: Schema.optional(Schema.Literal("Standard", "Fast")),
  fast: Schema.optional(Schema.Boolean),
  autonomy: Schema.optional(AutonomySchema),
  max_subagents: Schema.optional(
    Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value > 0)),
  ),
  computer_use: Schema.optional(Schema.Boolean),
  work: Schema.optional(Schema.Boolean),
  web: Schema.optional(Schema.Boolean),
  security: Schema.optional(Schema.Boolean),
  managed_config: Schema.optional(JsonObjectSchema),
  managedConfig: Schema.optional(JsonObjectSchema),
  ownership: Schema.optional(JsonObjectSchema),
  ownership_metadata: Schema.optional(JsonObjectSchema),
  saved_workflows: Schema.optional(JsonValueSchema),
  workflow_saves: Schema.optional(JsonValueSchema),
  runs: Schema.optional(JsonValueSchema),
  continuations: Schema.optional(JsonValueSchema),
  refinements: Schema.optional(JsonValueSchema),
});

const MigrationStateSchema = Schema.Struct({
  schema_epoch: Schema.Literal(STATE_SCHEMA_EPOCH),
  source_epoch: Schema.Literal(LEGACY_SCHEMA_EPOCH),
  source_digest: DigestSchema,
  migrated_at: DateTextSchema,
  selections: Schema.Struct({
    plan: PlanNameSchema,
    tier: Schema.Literal("Standard", "Fast"),
    autonomy: AutonomySchema,
    max_subagents: Schema.Number.pipe(
      Schema.filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
    computer_use: Schema.Boolean,
    work: Schema.Boolean,
    web: Schema.Boolean,
    security: Schema.Boolean,
  }),
  managed_config: JsonObjectSchema,
  ownership: JsonObjectSchema,
  saved_workflows: JsonValueSchema,
  runs: JsonValueSchema,
  continuations: JsonValueSchema,
  refinements: JsonValueSchema,
});
type MigrationState = typeof MigrationStateSchema.Type;

export interface MigratedInstallerSelections {
  readonly plan: PlanName;
  readonly tier: ServiceTier;
  readonly autonomy: "manual" | "assisted" | "autonomous";
  readonly max_subagents: number;
  readonly optional: Readonly<{
    readonly computer_use: boolean;
    readonly work: boolean;
    readonly web: boolean;
    readonly security: boolean;
  }>;
}

const MigrationRecordSchema = Schema.Struct({
  schema_epoch: Schema.Literal(STATE_SCHEMA_EPOCH),
  source_epoch: Schema.Literal(LEGACY_SCHEMA_EPOCH),
  source_digest: DigestSchema,
  status: Schema.Literal("started", "completed", "quarantined"),
  source_paths: Schema.Array(Schema.String),
  target_path: Schema.String,
  updated_at: DateTextSchema,
  reason: Schema.optional(Schema.String),
});
type MigrationRecord = typeof MigrationRecordSchema.Type;

export interface MigrationReport {
  readonly status: "none" | "migrated" | "reused" | "quarantined";
  readonly source_paths: readonly string[];
  readonly target_path: string;
  readonly historical_retained: boolean;
  readonly recovery: "none" | "resumed" | "quarantined";
}

export async function migrateLegacyState(
  paths: ResolvedInstallerPaths,
  now: () => Date = () => new Date(),
): Promise<MigrationReport> {
  await assertNoSymlinkTree(paths.codexHome);
  await assertNoSymlinkTree(paths.marketplaceRoot);
  await assertNoSymlinkTree(paths.stateRoot);
  await ensureOwnedDirectory(paths.stateRoot);
  const targetPath = join(paths.stateRoot, MIGRATED_STATE_NAME);
  const recordPath = join(paths.stateRoot, MIGRATION_RECORD_NAME);
  let existingRecord: MigrationRecord | undefined;
  try {
    existingRecord = await optionalJsonFile(recordPath, MigrationRecordSchema);
  } catch (error: unknown) {
    const sources = await findLegacySources(paths);
    const sourcePaths = sources.map((source) => source.path);
    await quarantineSources(
      paths,
      [...sources, { path: recordPath, kind: "migration-record" }],
      now,
      "migration journal failed Effect Schema validation",
    );
    await writeMigrationRecord(recordPath, {
      schema_epoch: STATE_SCHEMA_EPOCH,
      source_epoch: LEGACY_SCHEMA_EPOCH,
      source_digest: await digestValue({ source_paths: sourcePaths, error: "record-corrupt" }),
      status: "quarantined",
      source_paths: sourcePaths,
      target_path: targetPath,
      updated_at: now().toISOString(),
      reason: safeMessage(error),
    });
    return {
      status: "quarantined",
      source_paths: sourcePaths,
      target_path: targetPath,
      historical_retained: true,
      recovery: "quarantined",
    };
  }
  const sources = await findLegacySources(paths);
  if (sources.length === 0 && existingRecord?.status === "completed") {
    const state = await optionalJsonFile(targetPath, MigrationStateSchema);
    if (state === undefined || state.source_digest !== existingRecord.source_digest) {
      throw new StorageError(
        "state_corrupt",
        "The completed migration target is missing or stale.",
      );
    }
    return {
      status: "reused",
      source_paths: [],
      target_path: targetPath,
      historical_retained: true,
      recovery: "none",
    };
  }
  if (sources.length === 0 && existingRecord?.status !== "started") {
    return {
      status: "none",
      source_paths: [],
      target_path: targetPath,
      historical_retained: false,
      recovery: "none",
    };
  }

  let merged: JsonObject;
  try {
    merged = await readAndMergeSources(sources);
  } catch (error: unknown) {
    const sourcePaths = sources.map((source) => source.path);
    await quarantineSources(paths, sources, now, safeMessage(error));
    await writeMigrationRecord(recordPath, {
      schema_epoch: STATE_SCHEMA_EPOCH,
      source_epoch: LEGACY_SCHEMA_EPOCH,
      source_digest: await digestValue({ sources: sourcePaths, error: "schema-rejected" }),
      status: "quarantined",
      source_paths: sourcePaths,
      target_path: targetPath,
      updated_at: now().toISOString(),
      reason: "legacy state failed Effect Schema validation",
    });
    return {
      status: "quarantined",
      source_paths: sourcePaths,
      target_path: targetPath,
      historical_retained: true,
      recovery: "quarantined",
    };
  }

  const sourcePaths = sources.map((source) => source.path);
  const sourceDigest = await digestValue({ source_paths: sourcePaths, state: merged });
  const prior = existingRecord?.source_digest === sourceDigest ? existingRecord : undefined;
  const recovered = existingRecord?.status === "started";
  if (prior?.status === "completed") {
    let state: MigrationState | undefined;
    try {
      state = await optionalJsonFile(targetPath, MigrationStateSchema);
    } catch (error: unknown) {
      await quarantineSources(
        paths,
        [{ path: targetPath, kind: "migrated-state" }],
        now,
        "migrated state failed Effect Schema validation",
      );
      await writeMigrationRecord(recordPath, {
        schema_epoch: STATE_SCHEMA_EPOCH,
        source_epoch: LEGACY_SCHEMA_EPOCH,
        source_digest: sourceDigest,
        status: "quarantined",
        source_paths: sourcePaths,
        target_path: targetPath,
        updated_at: now().toISOString(),
        reason: safeMessage(error),
      });
      return {
        status: "quarantined",
        source_paths: sourcePaths,
        target_path: targetPath,
        historical_retained: true,
        recovery: "quarantined",
      };
    }
    if (state?.source_digest === sourceDigest) {
      await projectLegacyState(merged, paths, now);
      return {
        status: "reused",
        source_paths: sourcePaths,
        target_path: targetPath,
        historical_retained: true,
        recovery: recovered ? "resumed" : "none",
      };
    }
    if (state === undefined && sources.length === 0) {
      throw new StorageError("state_corrupt", "The completed migration target is missing.");
    }
  }

  let state: MigrationState;
  try {
    state = createMigrationState(merged, sourceDigest, now);
  } catch (error: unknown) {
    await quarantineSources(paths, sources, now, safeMessage(error));
    await writeMigrationRecord(recordPath, {
      schema_epoch: STATE_SCHEMA_EPOCH,
      source_epoch: LEGACY_SCHEMA_EPOCH,
      source_digest: sourceDigest,
      status: "quarantined",
      source_paths: sourcePaths,
      target_path: targetPath,
      updated_at: now().toISOString(),
      reason: "legacy state could not be transformed",
    });
    return {
      status: "quarantined",
      source_paths: sourcePaths,
      target_path: targetPath,
      historical_retained: true,
      recovery: "quarantined",
    };
  }
  await writeMigrationRecord(recordPath, {
    schema_epoch: STATE_SCHEMA_EPOCH,
    source_epoch: LEGACY_SCHEMA_EPOCH,
    source_digest: sourceDigest,
    status: "started",
    source_paths: sourcePaths,
    target_path: targetPath,
    updated_at: now().toISOString(),
  });
  await writeAtomicJson(targetPath, asJsonValue(state));
  const validated = await optionalJsonFile(targetPath, MigrationStateSchema);
  if (!validated || validated.source_digest !== sourceDigest) {
    throw new StorageError("state_corrupt", "The migrated state could not be verified.");
  }
  try {
    await projectLegacyState(merged, paths, now);
  } catch (error: unknown) {
    await quarantineSources(paths, sources, now, safeMessage(error));
    await writeMigrationRecord(recordPath, {
      schema_epoch: STATE_SCHEMA_EPOCH,
      source_epoch: LEGACY_SCHEMA_EPOCH,
      source_digest: sourceDigest,
      status: "quarantined",
      source_paths: sourcePaths,
      target_path: targetPath,
      updated_at: now().toISOString(),
      reason: "legacy state projection failed closed",
    });
    return {
      status: "quarantined",
      source_paths: sourcePaths,
      target_path: targetPath,
      historical_retained: true,
      recovery: recovered ? "resumed" : "quarantined",
    };
  }
  await writeMigrationRecord(recordPath, {
    schema_epoch: STATE_SCHEMA_EPOCH,
    source_epoch: LEGACY_SCHEMA_EPOCH,
    source_digest: sourceDigest,
    status: "completed",
    source_paths: sourcePaths,
    target_path: targetPath,
    updated_at: now().toISOString(),
  });
  return {
    status: "migrated",
    source_paths: sourcePaths,
    target_path: targetPath,
    historical_retained: true,
    recovery: recovered ? "resumed" : "none",
  };
}

async function projectLegacyState(
  input: JsonObject,
  paths: ResolvedInstallerPaths,
  now: () => Date,
): Promise<void> {
  await projectSavedWorkflows(input["saved_workflows"] ?? input["workflow_saves"], paths, now);
  await projectRuns(input["runs"], paths);
  await projectContinuationClaims(input["continuations"], paths);
  await projectRefinements(input["refinements"], paths);
}

async function projectSavedWorkflows(
  value: JsonValue | undefined,
  paths: ResolvedInstallerPaths,
  now: () => Date,
): Promise<void> {
  for (const entry of legacyEntries(value)) {
    const name = entry["name"];
    const source = entry["source"];
    if (typeof name !== "string" || typeof source !== "string") {
      throw new StorageError("state_corrupt", "A saved workflow projection is incomplete.");
    }
    const scope = entry["scope"] === "project" ? "project" : "user";
    const projectRoot = typeof entry["project_root"] === "string" ? entry["project_root"] : "";
    if (scope === "project" && projectRoot.length === 0) {
      throw new StorageError("state_corrupt", "A project workflow projection lacks its root.");
    }
    try {
      const existing = await readSavedWorkflow(paths.stateRoot, scope, name, projectRoot);
      if (existing.source !== source) {
        throw new StorageError("state_corrupt", "A saved workflow conflicts with existing state.");
      }
    } catch (error: unknown) {
      if (!(error instanceof WorkflowStoreError) || error.code !== "workflow_missing") {
        throw error;
      }
      await saveWorkflow(paths.stateRoot, scope, name, source, projectRoot, now);
    }
  }
}

async function projectRuns(
  value: JsonValue | undefined,
  paths: ResolvedInstallerPaths,
): Promise<void> {
  const store = new FileRunStore(paths.stateRoot);
  for (const entry of legacyEntries(value)) {
    const snapshot = decodeHostSchema(RunSnapshotSchema, entry["snapshot"]);
    if (snapshot === undefined) {
      continue;
    }
    const event = decodeHostSchema(JournalEventSchema, entry["event"]);
    if (event === undefined) {
      throw new StorageError("state_corrupt", "A migrated run lacks a valid journal event.");
    }
    await createOrVerifyRun(store, snapshot, event);
  }
}

async function createOrVerifyRun(
  store: FileRunStore,
  snapshot: RunSnapshot,
  event: JournalEvent,
): Promise<void> {
  try {
    const existing = await store.load(snapshot.definition.run_id);
    if (canonicalJson(existing.snapshot) !== canonicalJson(snapshot)) {
      throw new StorageError("state_corrupt", "A migrated run conflicts with an existing run.");
    }
    const existingEvent = existing.journal.find(
      (candidate) => candidate.sequence === event.sequence,
    );
    if (existingEvent === undefined || canonicalJson(existingEvent) !== canonicalJson(event)) {
      throw new StorageError(
        "state_corrupt",
        "A migrated run journal conflicts with existing state.",
      );
    }
    return;
  } catch (error: unknown) {
    if (error instanceof WorkflowHostError && error.code === "run_missing") {
      await store.createRun(snapshot, event);
      return;
    }
    throw error;
  }
}

async function projectContinuationClaims(
  value: JsonValue | undefined,
  paths: ResolvedInstallerPaths,
): Promise<void> {
  const store = new FileRunStore(paths.stateRoot);
  for (const entry of legacyEntries(value)) {
    const claim = decodeHostSchema(ContinuationClaimSchema, entry["claim"]);
    if (claim === undefined) continue;
    if (await store.hasContinuationClaim(claim.packet_id)) continue;
    await store.claimContinuation(claim);
  }
}

async function projectRefinements(
  value: JsonValue | undefined,
  paths: ResolvedInstallerPaths,
): Promise<void> {
  for (const entry of legacyEntries(value)) {
    const refinement = decodeHostSchema(RefinementSchema, entry);
    if (refinement === undefined) continue;
    await replaceRefinement(paths.stateRoot, refinement);
  }
}

function legacyEntries(value: JsonValue | undefined): readonly JsonObject[] {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const parsed = decodeSchema(JsonObjectSchema, entry);
      if (parsed === undefined) {
        throw new StorageError(
          "state_corrupt",
          "A migrated collection contains a non-object entry.",
        );
      }
      return parsed;
    });
  }
  const parsed = decodeSchema(JsonObjectSchema, value);
  return parsed === undefined ? [] : [parsed];
}

export async function inspectLegacyState(paths: ResolvedInstallerPaths): Promise<MigrationReport> {
  await assertNoSymlinkTree(paths.codexHome);
  await assertNoSymlinkTree(paths.marketplaceRoot);
  await assertNoSymlinkTree(paths.stateRoot);
  const recordPath = join(paths.stateRoot, MIGRATION_RECORD_NAME);
  const targetPath = join(paths.stateRoot, MIGRATED_STATE_NAME);
  const record = await optionalJsonFile(recordPath, MigrationRecordSchema);
  const sources = await findLegacySources(paths);
  let target: MigrationState | undefined;
  try {
    target = await optionalJsonFile(targetPath, MigrationStateSchema);
  } catch {
    return {
      status: "quarantined",
      source_paths: sources.map((source) => source.path),
      target_path: targetPath,
      historical_retained: true,
      recovery: "quarantined",
    };
  }
  if (record?.status === "completed" && target?.source_digest !== record.source_digest) {
    return {
      status: "quarantined",
      source_paths: sources.map((source) => source.path),
      target_path: targetPath,
      historical_retained: true,
      recovery: "quarantined",
    };
  }
  return {
    status:
      record?.status === "quarantined"
        ? "quarantined"
        : record?.status === "completed"
          ? "reused"
          : sources.length > 0
            ? "migrated"
            : "none",
    source_paths: sources.map((source) => source.path),
    target_path: targetPath,
    historical_retained: sources.length > 0 || record !== undefined || target !== undefined,
    recovery: record?.status === "started" ? "resumed" : "none",
  };
}

export async function readMigratedInstallerSelections(
  paths: ResolvedInstallerPaths,
): Promise<MigratedInstallerSelections | undefined> {
  const state = await optionalJsonFile(
    join(paths.stateRoot, MIGRATED_STATE_NAME),
    MigrationStateSchema,
  );
  if (!state) return undefined;
  const selections = state.selections;
  const plan = decodeSchema(PlanNameSchema, selections.plan);
  if (!plan) throw new StorageError("state_corrupt", "The migrated plan is invalid.");
  return {
    plan,
    tier: selections.tier,
    autonomy: selections.autonomy,
    max_subagents: selections.max_subagents,
    optional: {
      computer_use: selections.computer_use,
      work: selections.work,
      web: selections.web,
      security: selections.security,
    },
  };
}

function createMigrationState(
  input: JsonObject,
  sourceDigest: string,
  now: () => Date,
): MigrationState {
  const tier = input["tier"] === "Fast" || input["fast"] === true ? "Fast" : "Standard";
  if (input["tier"] === "Standard" && input["fast"] === true) {
    throw new StorageError("state_corrupt", "Legacy Fast and tier selections conflict.");
  }
  const state: JsonObject = {
    schema_epoch: STATE_SCHEMA_EPOCH,
    source_epoch: LEGACY_SCHEMA_EPOCH,
    source_digest: sourceDigest,
    migrated_at: now().toISOString(),
    selections: {
      plan: typeof input["plan"] === "string" ? input["plan"] : "plus",
      tier,
      autonomy: isAutonomy(input["autonomy"]) ? input["autonomy"] : "assisted",
      max_subagents:
        typeof input["max_subagents"] === "number" &&
        Number.isSafeInteger(input["max_subagents"]) &&
        input["max_subagents"] > 0
          ? input["max_subagents"]
          : 1,
      computer_use: input["computer_use"] === true,
      work: input["work"] === true,
      web: input["web"] === true,
      security: input["security"] === true,
    },
    managed_config: objectValue(input["managed_config"] ?? input["managedConfig"]),
    ownership: objectValue(input["ownership"] ?? input["ownership_metadata"]),
    saved_workflows: input["saved_workflows"] ?? input["workflow_saves"] ?? {},
    runs: input["runs"] ?? [],
    continuations: input["continuations"] ?? [],
    refinements: input["refinements"] ?? [],
  };
  const parsed = decodeSchema(MigrationStateSchema, state);
  if (!parsed) {
    throw new StorageError("state_corrupt", "The migrated state failed Effect Schema validation.");
  }
  return parsed;
}

async function findLegacySources(
  paths: ResolvedInstallerPaths,
): Promise<readonly Readonly<{ path: string; kind: string }>[]> {
  const legacyRoot = join(paths.stateRoot, "legacy");
  const candidates: Array<Readonly<{ path: string; kind: string }>> = [];
  const direct = [
    [join(paths.stateRoot, "legacy-state.json"), "legacy-state"],
    [join(paths.stateRoot, "legacy.json"), "legacy"],
  ] as const;
  for (const [path, kind] of direct) {
    if (await regularFile(path)) candidates.push({ path, kind });
  }
  try {
    await assertNoSymlink(legacyRoot);
    for (const entry of (await readdir(legacyRoot)).sort()) {
      if (!entry.endsWith(".json") || !/^[a-z][a-z0-9_-]{0,63}\.json$/u.test(entry)) continue;
      const path = join(legacyRoot, entry);
      if (await regularFile(path)) candidates.push({ path, kind: entry.slice(0, -5) });
    }
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) throw error;
  }
  return candidates;
}

async function readAndMergeSources(
  sources: readonly Readonly<{ path: string; kind: string }>[],
): Promise<JsonObject> {
  const merged: Record<string, JsonValue> = {};
  for (const source of sources) {
    const raw = await readJsonObject(source.path);
    const record = decodeSchema(LegacyRecordSchema, raw);
    if (!record) {
      throw new StorageError("state_corrupt", "A legacy state record is incompatible.");
    }
    if (
      record.schema_epoch !== undefined &&
      record.schema_epoch !== LEGACY_SCHEMA_EPOCH &&
      record.schema_epoch !== "legacy"
    ) {
      throw new StorageError("state_corrupt", "The legacy state epoch is not recognized.");
    }
    for (const key of Object.keys(raw)) {
      if (key === "schema_epoch") continue;
      const value = raw[key];
      if (value === undefined) continue;
      const previous = merged[key];
      if (previous !== undefined && canonicalJson(previous) !== canonicalJson(value)) {
        throw new StorageError("state_corrupt", "Legacy state records disagree.");
      }
      merged[key] = value;
    }
  }
  return merged;
}

async function writeMigrationRecord(path: string, record: MigrationRecord): Promise<void> {
  const parsed = decodeSchema(MigrationRecordSchema, record);
  if (!parsed) throw new StorageError("state_corrupt", "The migration record is invalid.");
  await writeAtomicJson(path, asJsonValue(parsed));
}

async function quarantineSources(
  paths: ResolvedInstallerPaths,
  sources: readonly Readonly<{ path: string; kind: string }>[],
  now: () => Date,
  reason: string,
): Promise<void> {
  const quarantineRoot = join(paths.stateRoot, "quarantine");
  await assertNoSymlinkTree(quarantineRoot);
  const quarantine = join(quarantineRoot, `legacy-${now().getTime()}`);
  await ensureOwnedDirectory(quarantine);
  for (const source of sources) {
    const destination = join(quarantine, source.kind + ".json");
    try {
      const entry = await lstat(source.path);
      if (entry.isFile() && !entry.isSymbolicLink()) {
        await copyFile(source.path, destination);
      }
    } catch {
      // Historical retention is best effort; the migration remains quarantined.
    }
  }
  await writeAtomicJson(join(quarantine, "reason.json"), { reason: reason.slice(0, 256) });
}

async function digestValue(value: JsonValue): Promise<string> {
  return await domainSeparatedSha256("holycodex-legacy-state", [
    new TextEncoder().encode(canonicalJson(value)),
  ]);
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return false;
    throw error;
  }
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return decodeSchema(JsonObjectSchema, value) ?? {};
}

function isAutonomy(value: JsonValue | undefined): value is "manual" | "assisted" | "autonomous" {
  return value === "manual" || value === "assisted" || value === "autonomous";
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "legacy state failed";
}
