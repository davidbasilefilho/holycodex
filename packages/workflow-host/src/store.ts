// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  normalizeSpecialistOutcome,
  RoleTaskSchema,
  SpecialistOutcomeSchema,
  type JsonObject,
} from "@holycodex/core";
import * as Schema from "effect/Schema";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ContinuationClaimSchema,
  JournalEventSchema,
  OperationLifecycleSchema,
  RunSnapshotSchema,
  decodeHostSchema,
  type ContinuationClaim,
  type JournalEvent,
  type RunDefinition,
  type RunId,
  type RunSnapshot,
  type CompatibilityCardinality,
  type WorkflowExecutionIdentity,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import { compatibilityProofDigest } from "./identity.ts";

const LegacyOperationEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("operation"),
  run_id: Schema.String,
  sequence: Schema.Number,
  at: Schema.String,
  lifecycle: OperationLifecycleSchema,
  outcome: SpecialistOutcomeSchema,
});

function operationRouteTask(
  lifecycle: import("./schemas.ts").OperationLifecycle,
): import("@holycodex/core").RoleTask | undefined {
  const [role, task, ...rest] = lifecycle.operation.route.split(":");
  if (role === undefined || task === undefined || rest.length > 0) {
    return undefined;
  }
  const route = decodeHostSchema(RoleTaskSchema, { role, task });
  if (
    route === undefined ||
    route.role !== lifecycle.operation.role ||
    route.task !== lifecycle.operation.task
  ) {
    return undefined;
  }
  return route;
}

function canonicalizeStoredEvent(event: JournalEvent): JournalEvent | undefined {
  if (event.event !== "operation") {
    return event;
  }
  if (
    event.session !== undefined &&
    (event.session.route !== event.lifecycle.operation.route ||
      event.session.role_task.role !== event.lifecycle.operation.role ||
      event.session.role_task.task !== event.lifecycle.operation.task ||
      event.session.fingerprint !== event.lifecycle.operation.input_digest)
  ) {
    return undefined;
  }
  const expectedRoute = operationRouteTask(event.lifecycle);
  if (expectedRoute === undefined || event.outcome === undefined) {
    return expectedRoute === undefined ? undefined : event;
  }
  const normalized = normalizeSpecialistOutcome(event.outcome, expectedRoute);
  return normalized.ok ? { ...event, outcome: normalized.value } : undefined;
}

/** Decodes current journal events and explicitly migrates legacy stored operation outcomes. */
export function decodeStoredJournalEvent(input: unknown): JournalEvent | undefined {
  const current = decodeHostSchema(JournalEventSchema, input);
  if (current !== undefined) {
    return canonicalizeStoredEvent(current);
  }
  const legacy = decodeHostSchema(LegacyOperationEventSchema, input);
  if (legacy === undefined) {
    return undefined;
  }
  const expectedRoute = operationRouteTask(legacy.lifecycle);
  if (expectedRoute === undefined) {
    return undefined;
  }
  const normalized = normalizeSpecialistOutcome(legacy.outcome, expectedRoute);
  if (!normalized.ok) {
    return undefined;
  }
  return decodeHostSchema(JournalEventSchema, {
    ...legacy,
    outcome: normalized.value,
  });
}

export type StoredRun = Readonly<{
  readonly snapshot: RunSnapshot;
  readonly journal: readonly JournalEvent[];
  readonly diagnostics: readonly IntegrityDiagnostic[];
}>;

export type IntegrityDiagnostic = Readonly<{
  readonly code:
    | "snapshot_mismatch"
    | "journal_divergent"
    | "transaction_incomplete"
    | "revision_mismatch"
    | "identity_mismatch"
    | "ledger_mismatch";
  readonly run_id: string;
}>;

type AppendLock = Promise<unknown>;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IGNORED_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF", "ENOSYS"]);
const APPEND_LOCK_TIMEOUT_MS = 5_000;
const APPEND_LOCK_WAIT_MS = 10;
const ZERO_DIGEST = "0".repeat(64);

type CommitIntentEvent = Extract<JournalEvent, { event: "commit-intent" }>;
type CommitRecordEvent = Extract<JournalEvent, { event: "commit-record" }>;

export type RevisionCommitBuilder = (
  input: Readonly<{
    readonly current: RunSnapshot;
    readonly eventSequence: number;
    readonly revision: number;
  }>,
) =>
  | Promise<Readonly<{ readonly snapshot: RunSnapshot; readonly event: JournalEvent }>>
  | Readonly<{
      readonly snapshot: RunSnapshot;
      readonly event: JournalEvent;
    }>;

function isCommitIntent(event: JournalEvent): event is CommitIntentEvent {
  return event.event === "commit-intent";
}

function isCommitRecord(event: JournalEvent | undefined): event is CommitRecordEvent {
  return event?.event === "commit-record";
}

function stripRecordDigest(event: JournalEvent): Omit<JournalEvent, "record_digest"> {
  const { record_digest: _recordDigest, ...withoutDigest } = event;
  return withoutDigest;
}

async function journalRecordDigest(event: JournalEvent): Promise<string> {
  return await domainSeparatedSha256("workflow-host-journal-record-v1", [
    canonicalJsonUtf8(stripRecordDigest(event)),
  ]);
}

async function journalPayloadDigest(event: JournalEvent): Promise<string> {
  const { previous_digest: _previousDigest, record_digest: _recordDigest, ...payload } = event;
  return await domainSeparatedSha256("workflow-host-journal-payload-v1", [
    canonicalJsonUtf8(payload),
  ]);
}

function operationState(journal: readonly JournalEvent[]): JsonObject | null {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const event = journal[index];
    if (event?.event === "operation") {
      return {
        operation_id: event.lifecycle.operation.operation_id,
        state: event.lifecycle.state,
      };
    }
  }
  return null;
}

async function checkpointDigest(snapshot: RunSnapshot): Promise<string | null> {
  if (snapshot.checkpoint === null) {
    return null;
  }
  return await domainSeparatedSha256("workflow-checkpoint", [
    canonicalJsonUtf8(snapshot.checkpoint),
  ]);
}

async function snapshotDigest(snapshot: RunSnapshot): Promise<string> {
  return await domainSeparatedSha256("workflow-host-snapshot-v1", [canonicalJsonUtf8(snapshot)]);
}

function derivedDelegationMode(
  executionMode: "native" | "compatibility",
  cardinality: CompatibilityCardinality | undefined,
  existing: "DIRECT" | "SINGLE" | "DYNAMIC_WORKFLOW" | undefined,
): "SINGLE" | "DYNAMIC_WORKFLOW" | "DIRECT" {
  if (executionMode === "native") {
    return existing === "DIRECT" ? "DIRECT" : existing === "SINGLE" ? "SINGLE" : "DYNAMIC_WORKFLOW";
  }
  if (cardinality?.status === "proven" && cardinality.expected_calls <= 1) {
    return "SINGLE";
  }
  return "DYNAMIC_WORKFLOW";
}

async function migrateSnapshot(snapshot: RunSnapshot): Promise<{
  readonly snapshot: RunSnapshot;
  readonly diagnostics: readonly IntegrityDiagnostic[];
}> {
  const descriptor = snapshot.workflow;
  if (descriptor === undefined) {
    return { snapshot, diagnostics: [] };
  }
  const executionMode = descriptor.execution_mode;
  let cardinality: CompatibilityCardinality | undefined;
  let proofValid = true;
  if (executionMode === "compatibility") {
    cardinality = descriptor.compatibility_cardinality;
    if (
      cardinality === undefined &&
      descriptor.expected_calls !== undefined &&
      descriptor.expected_calls > 0
    ) {
      const legacyProof = descriptor.expected_calls_proof_digest ?? descriptor.proof_digest;
      if (
        legacyProof !== undefined &&
        legacyProof ===
          (await compatibilityProofDigest(descriptor.source, descriptor.expected_calls))
      ) {
        cardinality = {
          status: "proven",
          expected_calls: descriptor.expected_calls,
          proof_digest: legacyProof,
        };
      } else if (legacyProof !== undefined) {
        proofValid = false;
      }
    }
    if (cardinality?.status === "proven") {
      proofValid =
        (await compatibilityProofDigest(descriptor.source, cardinality.expected_calls)) ===
        cardinality.proof_digest;
      if (!proofValid) {
        cardinality = { status: "unknown" };
      }
    } else {
      cardinality = { status: "unknown" };
    }
  }
  const delegationMode = derivedDelegationMode(
    executionMode,
    cardinality,
    descriptor.delegation_mode,
  );
  const persistedModeContradiction =
    executionMode === "compatibility" &&
    cardinality?.status === "proven" &&
    descriptor.delegation_mode !== undefined &&
    descriptor.delegation_mode !== delegationMode;
  const nativeDirectMode = executionMode === "native" && delegationMode === "DIRECT";
  const executionIdentity: WorkflowExecutionIdentity = {
    execution_mode: executionMode,
    delegation_mode: delegationMode,
    compatibility_cardinality: executionMode === "compatibility" ? cardinality! : null,
  };
  const existingIdentity = snapshot.definition.identity.workflow_execution;
  const identity = {
    ...snapshot.definition.identity,
    workflow_execution: executionIdentity,
  };
  const migratedDescriptor = {
    ...descriptor,
    delegation_mode: delegationMode,
    ...(executionMode === "compatibility" ? { compatibility_cardinality: cardinality } : {}),
    execution_identity: executionIdentity,
  };
  const migrated = {
    ...snapshot,
    definition: { ...snapshot.definition, identity },
    workflow: migratedDescriptor,
  };
  const parsed = decodeHostSchema(RunSnapshotSchema, migrated);
  if (parsed === undefined) {
    return {
      snapshot: { ...snapshot, integrity: "uncertain" },
      diagnostics: [{ code: "identity_mismatch", run_id: snapshot.definition.run_id }],
    };
  }
  const diagnostics: IntegrityDiagnostic[] = [];
  if (
    !proofValid ||
    persistedModeContradiction ||
    nativeDirectMode ||
    (existingIdentity !== undefined &&
      canonicalJson(existingIdentity) !== canonicalJson(executionIdentity))
  ) {
    diagnostics.push({ code: "identity_mismatch", run_id: snapshot.definition.run_id });
  }
  return { snapshot: parsed, diagnostics };
}

function now(): string {
  return new Date().toISOString();
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isUnsupportedSyncCode(code: unknown): boolean {
  return (
    typeof code === "string" &&
    (IGNORED_FSYNC_CODES.has(code) || (process.platform === "win32" && code === "EPERM"))
  );
}

function assertValidRunId(runId: string): asserts runId is RunId {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new WorkflowHostError("path_rejected", "The run identifier is not a safe path segment.");
  }
}

async function syncPath(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (!isUnsupportedSyncCode(code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  await syncPath(path).catch((error: unknown) => {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (!isUnsupportedSyncCode(code)) {
      throw error;
    }
  });
}

type AppendLease = Readonly<{ readonly release: () => Promise<void> }>;

async function acquireAppendLock(path: string): Promise<AppendLease> {
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const deadline = Date.now() + APPEND_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
      try {
        await writeFile(join(path, "owner"), token, { mode: 0o600 });
      } catch (error) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      return {
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          const owner = await readFile(join(path, "owner"), "utf8").catch(() => undefined);
          if (owner !== token) {
            throw new WorkflowHostError("persistence_failed", "The journal append lock changed.");
          }
          await rm(path, { recursive: true, force: false });
        },
      };
    } catch (error: unknown) {
      if (!isErrorCode(error, "EEXIST")) {
        throw new WorkflowHostError(
          "persistence_failed",
          "The journal append lock could not be acquired.",
          {},
          { cause: error },
        );
      }
      const entry = await lstat(path).catch((entryError: unknown) => {
        if (isErrorCode(entryError, "ENOENT")) {
          return undefined;
        }
        throw entryError;
      });
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
        throw new WorkflowHostError("path_rejected", "The journal append lock is not safe.");
      }
      if (Date.now() >= deadline) {
        throw new WorkflowHostError(
          "persistence_failed",
          "The journal append lock remained owned past its bounded wait.",
        );
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, APPEND_LOCK_WAIT_MS));
    }
  }
}

export class FileRunStore {
  readonly root: string;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private readonly appendLocks = new Map<string, AppendLock>();

  constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new WorkflowHostError("path_rejected", "The run store root must be absolute.");
    }
    this.root = resolve(root);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initialization !== undefined) {
      return await this.initialization;
    }
    const initialization = (async (): Promise<void> => {
      try {
        await mkdir(this.root, { recursive: true });
        const rootStat = await lstat(this.root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
          throw new WorkflowHostError(
            "path_rejected",
            "The run store root must be a real directory owned by HolyCodex.",
          );
        }
        for (const directory of ["runs", "claims", "quarantine"]) {
          await this.ensureDirectory(join(this.root, directory));
        }
        this.initialized = true;
      } catch (error) {
        if (error instanceof WorkflowHostError) {
          throw error;
        }
        throw new WorkflowHostError(
          "persistence_failed",
          "The run store could not be initialized.",
          {},
          { cause: error },
        );
      }
    })();
    this.initialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.initialization === initialization) {
        this.initialization = undefined;
      }
    }
  }

  async createRun(snapshot: RunSnapshot, event: JournalEvent): Promise<void> {
    await this.init();
    const parsedSnapshot = decodeHostSchema(RunSnapshotSchema, snapshot);
    const parsedEvent = decodeHostSchema(JournalEventSchema, event);
    if (parsedSnapshot === undefined) {
      throw new WorkflowHostError("invalid_input", "The run snapshot is invalid.");
    }
    if (parsedEvent === undefined) {
      throw new WorkflowHostError("invalid_input", "The run journal event is invalid.");
    }
    assertValidRunId(snapshot.definition.run_id);
    const directory = await this.ensureRunDirectory(snapshot.definition.run_id);
    const snapshotPath = join(directory, "snapshot.json");
    try {
      await stat(snapshotPath);
      throw new WorkflowHostError("persistence_failed", "The run already exists.");
    } catch (error) {
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      if (!isErrorCode(error, "ENOENT")) {
        throw new WorkflowHostError("persistence_failed", "The run snapshot cannot be created.");
      }
    }
    try {
      await this.writeAtomic(snapshotPath, parsedSnapshot);
      const initialSnapshotDigest = await snapshotDigest(parsedSnapshot);
      const storedEvent = await this.appendJournalNext(snapshot.definition.run_id, () => event);
      const initialJournalDigest = await journalPayloadDigest(storedEvent);
      const transactionId = `transaction-${crypto.randomUUID().replaceAll("-", "")}`;
      const storedIntent = await this.appendJournalNext(snapshot.definition.run_id, (sequence) => ({
        schema_epoch: "host-journal-1.0" as const,
        event: "commit-intent" as const,
        run_id: snapshot.definition.run_id,
        sequence,
        at: now(),
        transaction_version: "host-commit-1.0" as const,
        transaction_id: transactionId,
        previous_revision: 0,
        new_revision: 0,
        snapshot_digest: initialSnapshotDigest,
        journal_sequence: storedEvent.sequence,
        journal_digest: initialJournalDigest,
        checkpoint_revision: null,
        checkpoint_digest: null,
        operation_state: null,
      }));
      await this.appendJournalNext(snapshot.definition.run_id, (sequence) => ({
        schema_epoch: "host-journal-1.0" as const,
        event: "commit-record" as const,
        run_id: snapshot.definition.run_id,
        sequence,
        at: now(),
        transaction_version: "host-commit-1.0" as const,
        transaction_id: transactionId,
        intent_digest: storedIntent.record_digest ?? ZERO_DIGEST,
        previous_revision: 0,
        new_revision: 0,
        snapshot_digest: initialSnapshotDigest,
        journal_sequence: storedEvent.sequence,
        journal_digest: initialJournalDigest,
        checkpoint_revision: null,
        checkpoint_digest: null,
        operation_state: null,
      }));
    } catch (error) {
      await rm(directory, { recursive: true, force: false }).catch(() => undefined);
      throw error;
    }
  }

  async load(runId: string, reconcile = true): Promise<StoredRun> {
    await this.init();
    assertValidRunId(runId);
    try {
      const runEntry = await lstat(this.safePath("runs", runId));
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) {
        throw new WorkflowHostError("path_rejected", "The run directory is not safe.");
      }
    } catch (error) {
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      if (isErrorCode(error, "ENOENT")) {
        throw new WorkflowHostError("run_missing", "The run does not exist.");
      }
      throw new WorkflowHostError(
        "persistence_failed",
        "The run directory could not be read.",
        {},
        { cause: error },
      );
    }
    const directory = await this.ensureRunDirectory(runId);
    const snapshotPath = join(directory, "snapshot.json");
    let rawSnapshot: RunSnapshot;
    try {
      const snapshotEntry = await lstat(snapshotPath);
      if (snapshotEntry.isSymbolicLink() || !snapshotEntry.isFile()) {
        throw new WorkflowHostError("path_rejected", "The run snapshot is not a regular file.");
      }
      const parsed = decodeHostSchema(
        RunSnapshotSchema,
        JSON.parse(await readFile(snapshotPath, "utf8")),
      );
      if (parsed === undefined || parsed.definition.run_id !== runId) {
        throw new WorkflowHostError("integrity_uncertain", "The run snapshot is not trusted.");
      }
      rawSnapshot = parsed;
    } catch (error) {
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      await this.quarantine(runId, "snapshot", "snapshot could not be read");
      throw new WorkflowHostError(
        "integrity_uncertain",
        "The run snapshot is not trusted.",
        {},
        { cause: error },
      );
    }

    const migrated = await migrateSnapshot(rawSnapshot);
    let snapshot = migrated.snapshot;
    const diagnostics: IntegrityDiagnostic[] = [...migrated.diagnostics];
    const mark = async (code: IntegrityDiagnostic["code"], kind: string): Promise<void> => {
      if (!diagnostics.some((item) => item.code === code)) {
        diagnostics.push({ code, run_id: runId });
        await this.quarantine(runId, kind, code);
      }
    };

    const journalPath = join(directory, "journal.ndjson");
    let rawJournal = "";
    try {
      const journalEntry = await lstat(journalPath);
      if (journalEntry.isSymbolicLink() || !journalEntry.isFile()) {
        throw new WorkflowHostError("path_rejected", "The run journal is not a regular file.");
      }
      rawJournal = await readFile(journalPath, "utf8");
    } catch (error) {
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      await mark("journal_divergent", "journal");
      return {
        snapshot: { ...snapshot, integrity: "uncertain" },
        journal: [],
        diagnostics,
      };
    }

    const journal: JournalEvent[] = [];
    let expectedSequence = 1;
    let previousDigest = ZERO_DIGEST;
    let chained = false;
    for (const line of rawJournal.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: JournalEvent | undefined;
      try {
        parsed = decodeStoredJournalEvent(JSON.parse(line));
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || parsed.run_id !== runId || parsed.sequence !== expectedSequence) {
        await mark("journal_divergent", "journal-record");
        break;
      }
      const hasPrevious = parsed.previous_digest !== undefined;
      const hasRecord = parsed.record_digest !== undefined;
      if (hasPrevious !== hasRecord) {
        await mark("journal_divergent", "journal-chain");
        break;
      }
      if (hasPrevious) {
        chained = true;
        if (parsed.previous_digest !== previousDigest) {
          await mark("journal_divergent", "journal-chain");
          break;
        }
        if ((await journalRecordDigest(parsed)) !== parsed.record_digest) {
          await mark("journal_divergent", "journal-chain");
          break;
        }
        previousDigest = parsed.record_digest;
      } else if (chained) {
        await mark("journal_divergent", "journal-chain");
        break;
      } else {
        previousDigest = await journalRecordDigest(parsed);
      }
      journal.push(parsed);
      expectedSequence += 1;
    }

    const first = journal[0];
    if (
      first?.event !== "run-created" ||
      canonicalJson(first.definition) !== canonicalJson(rawSnapshot.definition)
    ) {
      await mark("identity_mismatch", "run-identity");
    }

    const intents = new Map<
      string,
      { readonly intent: CommitIntentEvent; readonly index: number }
    >();
    let latestCommit: CommitRecordEvent | undefined;
    let lastRevision = 0;
    let sawCommit = false;
    let pendingRecovery:
      | Readonly<{
          readonly intent: CommitIntentEvent;
          readonly business: JournalEvent;
        }>
      | undefined;
    for (let index = 0; index < journal.length; index += 1) {
      const event = journal[index];
      if (event === undefined) continue;
      if (isCommitIntent(event)) {
        intents.set(event.transaction_id, { intent: event, index });
        const forwardBusiness = journal[index + 1];
        const forwardCommit = journal[index + 2];
        const backwardBusiness = journal[index - 1];
        const backwardCommit = journal[index + 1];
        const initialOrder =
          backwardBusiness?.sequence === event.journal_sequence && isCommitRecord(backwardCommit);
        const business = initialOrder ? backwardBusiness : forwardBusiness;
        const commit = initialOrder ? backwardCommit : forwardCommit;
        const commitMatches =
          commit !== undefined &&
          isCommitRecord(commit) &&
          commit.transaction_id === event.transaction_id &&
          commit.intent_digest === event.record_digest &&
          commit.snapshot_digest === event.snapshot_digest &&
          commit.journal_sequence === event.journal_sequence &&
          commit.journal_digest === event.journal_digest &&
          commit.previous_revision === event.previous_revision &&
          commit.new_revision === event.new_revision &&
          commit.checkpoint_revision === event.checkpoint_revision &&
          commit.checkpoint_digest === event.checkpoint_digest &&
          canonicalJson(commit.operation_state) === canonicalJson(event.operation_state);
        const businessMatches =
          business !== undefined &&
          business.sequence === event.journal_sequence &&
          (await journalPayloadDigest(business)) === event.journal_digest;
        if (!businessMatches || !commitMatches) {
          if (
            business !== undefined &&
            businessMatches &&
            commit === undefined &&
            index + 2 === journal.length &&
            event.new_revision === snapshot.revision &&
            event.previous_revision === lastRevision &&
            event.new_revision === event.previous_revision + 1 &&
            event.snapshot_digest === (await snapshotDigest(snapshot))
          ) {
            pendingRecovery = { intent: event, business };
          } else {
            await mark("transaction_incomplete", "transaction");
          }
        } else {
          if (
            event.previous_revision !== lastRevision ||
            !(
              (initialOrder && event.previous_revision === 0 && event.new_revision === 0) ||
              event.new_revision === event.previous_revision + 1
            )
          ) {
            await mark("revision_mismatch", "revision");
          }
          lastRevision = event.new_revision;
          latestCommit = commit as CommitRecordEvent;
          sawCommit = true;
        }
      }
      if (isCommitRecord(event) && !intents.has(event.transaction_id)) {
        await mark("transaction_incomplete", "transaction");
      }
    }
    if (pendingRecovery !== undefined && !reconcile) {
      await mark("transaction_incomplete", "transaction");
    }
    if (pendingRecovery !== undefined && reconcile) {
      const recovered = await this.appendJournalNext(runId, (sequence) => ({
        schema_epoch: "host-journal-1.0" as const,
        event: "commit-record" as const,
        run_id: runId,
        sequence,
        at: now(),
        transaction_version: "host-commit-1.0" as const,
        transaction_id: pendingRecovery.intent.transaction_id,
        intent_digest: pendingRecovery.intent.record_digest ?? ZERO_DIGEST,
        previous_revision: pendingRecovery.intent.previous_revision,
        new_revision: pendingRecovery.intent.new_revision,
        snapshot_digest: pendingRecovery.intent.snapshot_digest,
        journal_sequence: pendingRecovery.intent.journal_sequence,
        journal_digest: pendingRecovery.intent.journal_digest,
        checkpoint_revision: pendingRecovery.intent.checkpoint_revision,
        checkpoint_digest: pendingRecovery.intent.checkpoint_digest,
        operation_state: pendingRecovery.intent.operation_state,
      }));
      journal.push(recovered);
      if (!isCommitRecord(recovered)) {
        throw new WorkflowHostError(
          "persistence_failed",
          "The recovered transaction did not produce a commit record.",
        );
      }
      latestCommit = recovered;
      sawCommit = true;
      lastRevision = recovered.new_revision;
    }
    if (chained && !sawCommit) {
      await mark("transaction_incomplete", "transaction");
    }
    if (
      latestCommit !== undefined &&
      (latestCommit.new_revision !== snapshot.revision ||
        latestCommit.snapshot_digest !== (await snapshotDigest(snapshot)))
    ) {
      await mark("snapshot_mismatch", "snapshot-digest");
    }

    const latestCheckpoint = [...journal]
      .reverse()
      .find(
        (event): event is Extract<JournalEvent, { event: "checkpoint" }> =>
          event.event === "checkpoint",
      );
    if (
      (snapshot.checkpoint === null && latestCheckpoint !== undefined) ||
      (snapshot.checkpoint !== null &&
        (latestCheckpoint === undefined ||
          latestCheckpoint.checkpoint.revision !== snapshot.checkpoint.revision ||
          latestCheckpoint.checkpoint.journal_sequence !== snapshot.checkpoint.journal_sequence ||
          canonicalJson(latestCheckpoint.checkpoint) !== canonicalJson(snapshot.checkpoint)))
    ) {
      await mark("revision_mismatch", "checkpoint");
    }

    const descriptor = snapshot.workflow;
    if (descriptor !== undefined) {
      const sourceDigest = await domainSeparatedSha256("workflow-source", [
        new TextEncoder().encode(descriptor.source),
      ]);
      const argsDigest = await domainSeparatedSha256("workflow-args", [
        canonicalJsonUtf8(descriptor.args),
      ]);
      if (
        sourceDigest !== snapshot.definition.identity.workflow_source_digest ||
        argsDigest !== snapshot.definition.identity.resupplied_args_digest ||
        descriptor.execution_identity === undefined ||
        snapshot.definition.identity.workflow_execution === undefined ||
        canonicalJson(descriptor.execution_identity) !==
          canonicalJson(snapshot.definition.identity.workflow_execution)
      ) {
        await mark("identity_mismatch", "descriptor-identity");
      }
    }

    let committedUnits = 0;
    for (const event of journal) {
      if (event.event !== "operation" || event.lifecycle.cost_accounting === undefined) {
        continue;
      }
      const accounting = event.lifecycle.cost_accounting;
      if (
        event.lifecycle.cost_units !== accounting.estimated_units ||
        accounting.committed_units < committedUnits
      ) {
        await mark("ledger_mismatch", "ledger");
      }
      committedUnits = Math.max(committedUnits, accounting.committed_units);
    }

    if (diagnostics.length > 0 || snapshot.integrity !== "valid") {
      snapshot = { ...snapshot, integrity: "uncertain" };
    }
    return { snapshot, journal, diagnostics };
  }

  async saveSnapshot(snapshot: RunSnapshot): Promise<void> {
    await this.init();
    const parsed = decodeHostSchema(RunSnapshotSchema, snapshot);
    if (parsed === undefined) {
      throw new WorkflowHostError("invalid_input", "The run snapshot is invalid.");
    }
    const directory = await this.ensureRunDirectory(snapshot.definition.run_id);
    await this.writeAtomic(join(directory, "snapshot.json"), snapshot);
  }

  /** Persists one snapshot revision and its journal event as one recoverable transaction. */
  async commitRevision(
    runId: string,
    builder: RevisionCommitBuilder,
  ): Promise<Readonly<{ readonly snapshot: RunSnapshot; readonly event: JournalEvent }>> {
    await this.init();
    assertValidRunId(runId);
    if (typeof builder !== "function") {
      throw new WorkflowHostError("invalid_input", "The revision transaction builder is invalid.");
    }
    const previous = this.appendLocks.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const directory = await this.ensureRunDirectory(runId);
      const lock = await acquireAppendLock(join(directory, ".append-lock"));
      try {
        const current = await this.load(runId, false);
        if (current.snapshot.integrity !== "valid") {
          throw new WorkflowHostError(
            "integrity_uncertain",
            "The run cannot accept a revision while its persisted state is uncertain.",
          );
        }
        const eventSequence = (current.journal.at(-1)?.sequence ?? 0) + 2;
        const revision = current.snapshot.revision + 1;
        const built = await builder({ current: current.snapshot, eventSequence, revision });
        const parsedSnapshot = decodeHostSchema(RunSnapshotSchema, built.snapshot);
        const parsedEvent = decodeHostSchema(JournalEventSchema, built.event);
        if (
          parsedSnapshot === undefined ||
          parsedEvent === undefined ||
          parsedSnapshot.definition.run_id !== runId ||
          parsedEvent.run_id !== runId ||
          parsedSnapshot.revision !== revision ||
          parsedEvent.sequence !== eventSequence
        ) {
          throw new WorkflowHostError(
            "state_corrupt",
            "The revision transaction contains an invalid snapshot or journal event.",
          );
        }
        const previousRecord = current.journal.at(-1);
        const previousDigest =
          previousRecord?.record_digest ??
          (previousRecord === undefined ? ZERO_DIGEST : await journalRecordDigest(previousRecord));
        const transactionId = `transaction-${crypto.randomUUID().replaceAll("-", "")}`;
        const snapshotDigestValue = await snapshotDigest(parsedSnapshot);
        const checkpointDigestValue = await checkpointDigest(parsedSnapshot);
        const operationStateValue = operationState([...current.journal, parsedEvent]);
        const intentCandidate: JournalEvent = {
          schema_epoch: "host-journal-1.0",
          event: "commit-intent",
          run_id: runId,
          sequence: eventSequence - 1,
          at: now(),
          transaction_version: "host-commit-1.0",
          transaction_id: transactionId,
          previous_revision: current.snapshot.revision,
          new_revision: revision,
          snapshot_digest: snapshotDigestValue,
          journal_sequence: eventSequence,
          journal_digest: await journalPayloadDigest(parsedEvent),
          checkpoint_revision: parsedSnapshot.checkpoint?.revision ?? null,
          checkpoint_digest: checkpointDigestValue,
          operation_state: operationStateValue,
        };
        const storedIntent = await this.appendRecord(
          join(directory, "journal.ndjson"),
          intentCandidate,
          previousDigest,
        );
        const storedEvent = await this.appendRecord(
          join(directory, "journal.ndjson"),
          parsedEvent,
          storedIntent.record_digest ?? ZERO_DIGEST,
        );
        await this.writeAtomic(join(directory, "snapshot.json"), parsedSnapshot);
        const commitCandidate: JournalEvent = {
          schema_epoch: "host-journal-1.0",
          event: "commit-record",
          run_id: runId,
          sequence: eventSequence + 1,
          at: now(),
          transaction_version: "host-commit-1.0",
          transaction_id: transactionId,
          intent_digest: storedIntent.record_digest ?? ZERO_DIGEST,
          previous_revision: current.snapshot.revision,
          new_revision: revision,
          snapshot_digest: snapshotDigestValue,
          journal_sequence: eventSequence,
          journal_digest: await journalPayloadDigest(parsedEvent),
          checkpoint_revision: parsedSnapshot.checkpoint?.revision ?? null,
          checkpoint_digest: checkpointDigestValue,
          operation_state: operationStateValue,
        };
        await this.appendRecord(
          join(directory, "journal.ndjson"),
          commitCandidate,
          storedEvent.record_digest ?? ZERO_DIGEST,
        );
        return { snapshot: parsedSnapshot, event: storedEvent };
      } finally {
        await lock.release();
      }
    });
    this.appendLocks.set(runId, next);
    try {
      return await next;
    } finally {
      if (this.appendLocks.get(runId) === next) {
        this.appendLocks.delete(runId);
      }
    }
  }

  async appendJournal(runId: string, event: JournalEvent): Promise<void> {
    await this.init();
    assertValidRunId(runId);
    const parsed = decodeHostSchema(JournalEventSchema, event);
    const canonical = parsed === undefined ? undefined : canonicalizeStoredEvent(parsed);
    if (canonical === undefined || canonical.run_id !== runId) {
      throw new WorkflowHostError("invalid_input", "The journal event does not match the run.");
    }
    await this.appendJournalWithFactory(runId, () => canonical);
  }

  async appendJournalNext(
    runId: string,
    factory: (sequence: number) => JournalEvent,
  ): Promise<JournalEvent> {
    await this.init();
    assertValidRunId(runId);
    if (typeof factory !== "function") {
      throw new WorkflowHostError("invalid_input", "The journal event factory is invalid.");
    }
    return await this.appendJournalWithFactory(runId, factory);
  }

  private async appendJournalWithFactory(
    runId: string,
    factory: (sequence: number) => JournalEvent,
  ): Promise<JournalEvent> {
    const previous = this.appendLocks.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const directory = await this.ensureRunDirectory(runId);
      const lock = await acquireAppendLock(join(directory, ".append-lock"));
      try {
        const journalPath = join(directory, "journal.ndjson");
        let journalMissing = false;
        try {
          const existing = await lstat(journalPath);
          if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new WorkflowHostError("path_rejected", "The run journal is not a regular file.");
          }
        } catch (error) {
          if (error instanceof WorkflowHostError) {
            throw error;
          }
          if (!isErrorCode(error, "ENOENT")) {
            throw error;
          }
          journalMissing = true;
        }
        let nextSequence = 1;
        let previousDigest = ZERO_DIGEST;
        try {
          const rawJournal = await readFile(journalPath, "utf8");
          for (const line of rawJournal.split("\n")) {
            if (line.trim().length === 0) {
              continue;
            }
            let existingJson: unknown;
            try {
              existingJson = JSON.parse(line) as unknown;
            } catch (error: unknown) {
              throw new WorkflowHostError(
                "state_corrupt",
                "The run journal contains invalid JSON.",
                {},
                { cause: error },
              );
            }
            const existing = decodeStoredJournalEvent(existingJson);
            if (
              existing === undefined ||
              existing.run_id !== runId ||
              existing.sequence !== nextSequence
            ) {
              throw new WorkflowHostError(
                "state_corrupt",
                "The run journal sequence is corrupt or ambiguous.",
              );
            }
            previousDigest = existing.record_digest ?? (await journalRecordDigest(existing));
            nextSequence += 1;
          }
        } catch (error: unknown) {
          if (error instanceof WorkflowHostError) {
            throw error;
          }
          if (!isErrorCode(error, "ENOENT")) {
            throw new WorkflowHostError(
              "persistence_failed",
              "The run journal could not be read before append.",
              {},
              { cause: error },
            );
          }
        }
        let candidate: JournalEvent;
        try {
          candidate = factory(nextSequence);
        } catch (error) {
          throw new WorkflowHostError(
            "invalid_input",
            "The journal event could not be formed.",
            {},
            { cause: error },
          );
        }
        const parsed = decodeHostSchema(JournalEventSchema, candidate);
        const canonical = parsed === undefined ? undefined : canonicalizeStoredEvent(parsed);
        if (canonical === undefined || canonical.run_id !== runId) {
          throw new WorkflowHostError("invalid_input", "The journal event does not match the run.");
        }
        if (canonical.sequence !== nextSequence) {
          throw new WorkflowHostError(
            "state_corrupt",
            "The appended journal event is not the next monotonic sequence.",
          );
        }
        if (journalMissing && (canonical.sequence !== 1 || canonical.event !== "run-created")) {
          throw new WorkflowHostError(
            "state_corrupt",
            "A missing run journal cannot be repaired by appending an arbitrary event.",
          );
        }
        const withPreviousDigest = {
          ...canonical,
          previous_digest: previousDigest,
        } as JournalEvent;
        const withRecordDigest = {
          ...withPreviousDigest,
          record_digest: await journalRecordDigest(withPreviousDigest),
        } as JournalEvent;
        const handle = await open(journalPath, "a", 0o600);
        try {
          await handle.writeFile(`${canonicalJson(withRecordDigest)}\n`, "utf8");
          await handle.sync().catch((error: unknown) => {
            const code =
              typeof error === "object" && error !== null && "code" in error ? error.code : null;
            if (typeof code !== "string" || !IGNORED_FSYNC_CODES.has(code)) {
              throw error;
            }
          });
        } finally {
          await handle.close();
        }
        return withRecordDigest;
      } finally {
        await lock.release();
      }
    });
    this.appendLocks.set(runId, next);
    try {
      return await next;
    } finally {
      if (this.appendLocks.get(runId) === next) {
        this.appendLocks.delete(runId);
      }
    }
  }

  private async appendRecord(
    journalPath: string,
    event: JournalEvent,
    previousDigest: string,
  ): Promise<JournalEvent> {
    const parsed = decodeHostSchema(JournalEventSchema, event);
    const canonical = parsed === undefined ? undefined : canonicalizeStoredEvent(parsed);
    if (canonical === undefined) {
      throw new WorkflowHostError("invalid_input", "The transaction journal event is invalid.");
    }
    const withPreviousDigest = { ...canonical, previous_digest: previousDigest } as JournalEvent;
    const withRecordDigest = {
      ...withPreviousDigest,
      record_digest: await journalRecordDigest(withPreviousDigest),
    } as JournalEvent;
    const handle = await open(journalPath, "a", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(withRecordDigest)}\n`, "utf8");
      await handle.sync().catch((error: unknown) => {
        const code =
          typeof error === "object" && error !== null && "code" in error ? error.code : null;
        if (typeof code !== "string" || !IGNORED_FSYNC_CODES.has(code)) {
          throw error;
        }
      });
    } finally {
      await handle.close();
    }
    return withRecordDigest;
  }

  async claimContinuation(claim: ContinuationClaim): Promise<void> {
    await this.init();
    const parsed = decodeHostSchema(ContinuationClaimSchema, claim);
    if (parsed === undefined) {
      throw new WorkflowHostError("invalid_input", "The continuation claim is invalid.");
    }
    const target = this.safePath("claims", `${claim.packet_id}.json`);
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, canonicalJson(claim), { mode: 0o600 });
      await syncPath(temporary);
      await link(temporary, target);
      await unlink(temporary);
      await syncDirectory(this.root);
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        throw new WorkflowHostError(
          "claim_conflict",
          "The continuation packet was already claimed.",
        );
      }
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      throw new WorkflowHostError(
        "persistence_failed",
        "The continuation claim could not be stored.",
        {},
        { cause: error },
      );
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async claimContinuationAndCreateRun(
    input: Readonly<{
      readonly claim: ContinuationClaim;
      readonly derivedDefinition: RunDefinition;
    }>,
  ): Promise<void> {
    await this.init();
    const parsedClaim = decodeHostSchema(ContinuationClaimSchema, input.claim);
    const derivedSnapshot: RunSnapshot = {
      schema_epoch: "host-run-1.0",
      definition: input.derivedDefinition,
      status: "created",
      revision: 0,
      checkpoint: null,
      integrity: "valid",
      updated_at: now(),
    };
    const derivedEvent: JournalEvent = {
      schema_epoch: "host-journal-1.0",
      event: "run-created",
      run_id: input.derivedDefinition.run_id,
      sequence: 1,
      at: now(),
      definition: input.derivedDefinition,
    };
    const parsedSnapshot = decodeHostSchema(RunSnapshotSchema, derivedSnapshot);
    const parsedEvent = decodeHostSchema(JournalEventSchema, derivedEvent);
    if (
      parsedClaim === undefined ||
      parsedSnapshot === undefined ||
      parsedEvent === undefined ||
      parsedEvent.event !== "run-created" ||
      parsedEvent.run_id !== parsedSnapshot.definition.run_id ||
      parsedSnapshot.definition.parent_run_id !== parsedClaim.parent_run_id
    ) {
      throw new WorkflowHostError("invalid_input", "The continuation-derived run is invalid.");
    }
    const lock = await acquireAppendLock(this.safePath("claims", ".continuation-lock"));
    const claimPath = this.safePath(
      "claims",
      `checkpoint-${parsedClaim.parent_run_id}-${parsedClaim.checkpoint_revision}-${parsedClaim.checkpoint_digest}.json`,
    );
    const packetPath = this.safePath("claims", `${parsedClaim.packet_id}.json`);
    const temporaryClaim = `${claimPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let claimLinked = false;
    let packetLinked = false;
    let created = false;
    try {
      const parent = await this.load(parsedClaim.parent_run_id);
      const checkpoint = parent.snapshot.checkpoint;
      const checkpointDigest =
        checkpoint === null
          ? null
          : await domainSeparatedSha256("workflow-checkpoint", [canonicalJsonUtf8(checkpoint)]);
      if (
        parent.snapshot.integrity !== "valid" ||
        (parent.snapshot.status !== "paused" && parent.snapshot.status !== "blocked") ||
        !checkpoint ||
        checkpoint.revision !== parsedClaim.checkpoint_revision ||
        checkpoint.run_id !== parsedClaim.parent_run_id ||
        checkpointDigest !== parsedClaim.checkpoint_digest ||
        canonicalJson(parent.snapshot.definition.identity.project) !==
          canonicalJson(parsedClaim.project) ||
        parent.snapshot.definition.identity.workflow_source_digest !== parsedClaim.source_digest
      ) {
        throw new WorkflowHostError(
          "claim_conflict",
          "The continuation checkpoint is stale or no longer eligible.",
        );
      }
      const existingClaim = await lstat(claimPath).catch((error: unknown) => {
        if (isErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (existingClaim) {
        throw new WorkflowHostError("claim_conflict", "The continuation checkpoint was claimed.");
      }
      const existingPacket = await lstat(packetPath).catch((error: unknown) => {
        if (isErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (existingPacket) {
        throw new WorkflowHostError("claim_conflict", "The continuation packet was claimed.");
      }
      assertValidRunId(parsedSnapshot.definition.run_id);
      await writeFile(temporaryClaim, canonicalJson(parsedClaim), { mode: 0o600 });
      await syncPath(temporaryClaim);
      await link(temporaryClaim, claimPath);
      claimLinked = true;
      await unlink(temporaryClaim);
      await link(claimPath, packetPath);
      packetLinked = true;
      await this.createRun(parsedSnapshot, parsedEvent);
      created = true;
      await this.appendJournalNext(parsedClaim.parent_run_id, (sequence) => ({
        schema_epoch: "host-journal-1.0",
        event: "continuation-claimed" as const,
        run_id: parsedClaim.parent_run_id,
        sequence,
        at: now(),
        claim: parsedClaim,
      }));
    } catch (error: unknown) {
      if (created) {
        await rm(this.safePath("runs", parsedSnapshot.definition.run_id), {
          recursive: true,
          force: false,
        }).catch(() => undefined);
      }
      if (packetLinked) {
        await unlink(packetPath).catch(() => undefined);
      }
      if (claimLinked) {
        await unlink(claimPath).catch(() => undefined);
      }
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      throw new WorkflowHostError(
        "persistence_failed",
        "The continuation-derived run could not be persisted.",
        {},
        { cause: error },
      );
    } finally {
      await unlink(temporaryClaim).catch(() => undefined);
      await lock.release();
    }
  }

  async hasContinuationClaim(packetId: string): Promise<boolean> {
    await this.init();
    const path = this.safePath("claims", `${packetId}.json`);
    try {
      const result = await lstat(path);
      return result.isFile() && !result.isSymbolicLink();
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return false;
      }
      throw new WorkflowHostError(
        "persistence_failed",
        "The continuation claim could not be read.",
        {},
        { cause: error },
      );
    }
  }

  async listSnapshots(): Promise<readonly RunSnapshot[]> {
    await this.init();
    const entries = await readdir(this.safePath("runs"), { withFileTypes: true });
    const snapshots: RunSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID_PATTERN.test(entry.name)) {
        continue;
      }
      try {
        const loaded = await this.load(entry.name);
        snapshots.push(loaded.snapshot);
      } catch {
        // Listing remains useful when one run is corrupt; inspect exposes the failure on demand.
      }
    }
    return snapshots;
  }

  private safePath(...parts: readonly string[]): string {
    const candidate = resolve(this.root, ...parts);
    const escaped = relative(this.root, candidate);
    if (escaped === ".." || escaped.startsWith(`..${sep}`) || escaped.includes(`${sep}..${sep}`)) {
      throw new WorkflowHostError("path_rejected", "A run-store path escaped its owned root.");
    }
    return candidate;
  }

  private async ensureDirectory(path: string): Promise<void> {
    const safe = this.safePath(relative(this.root, path));
    try {
      const existing = await lstat(safe);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new WorkflowHostError("path_rejected", "A run-store directory is not safe.");
      }
    } catch (error) {
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
      try {
        await mkdir(safe, { recursive: false, mode: 0o700 });
      } catch (mkdirError) {
        if (!isErrorCode(mkdirError, "EEXIST")) {
          throw mkdirError;
        }
        const concurrent = await lstat(safe);
        if (!concurrent.isDirectory() || concurrent.isSymbolicLink()) {
          throw new WorkflowHostError("path_rejected", "A run-store directory is not safe.");
        }
      }
    }
  }

  private async ensureRunDirectory(runId: string): Promise<string> {
    assertValidRunId(runId);
    const runsDirectory = this.safePath("runs");
    await this.ensureDirectory(runsDirectory);
    const runDirectory = this.safePath("runs", runId);
    await this.ensureDirectory(runDirectory);
    return runDirectory;
  }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    const directory = resolve(path, "..");
    const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const backup = `${path}.bak`;
    let backedUp = false;
    try {
      await writeFile(temporary, canonicalJson(value), { mode: 0o600 });
      await syncPath(temporary);
      if (process.platform === "win32") {
        const existingBackup = await lstat(backup).catch((error: unknown) => {
          if (isErrorCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
        if (existingBackup !== undefined) {
          if (existingBackup.isSymbolicLink() || !existingBackup.isFile()) {
            throw new WorkflowHostError("path_rejected", "The snapshot backup is not safe.");
          }
          await unlink(backup);
        }
        try {
          await rename(path, backup);
          backedUp = true;
        } catch (error) {
          if (!isErrorCode(error, "ENOENT")) {
            throw error;
          }
        }
      }
      await rename(temporary, path);
      if (backedUp) {
        await unlink(backup);
        backedUp = false;
      }
      await syncDirectory(directory);
    } catch (error) {
      if (backedUp) {
        await unlink(path).catch(() => undefined);
        await rename(backup, path).catch(() => undefined);
      }
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      throw new WorkflowHostError(
        "persistence_failed",
        "The run-store snapshot could not be written.",
        {},
        { cause: error },
      );
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async quarantine(runId: string, kind: string, reason: string): Promise<void> {
    await this.init();
    const digest = await domainSeparatedSha256("workflow-host-quarantine", [
      new TextEncoder().encode(`${runId}\u0000${kind}\u0000${reason}`),
    ]);
    const safeRun = RUN_ID_PATTERN.test(runId) ? runId : "invalid-run";
    const safeKind = kind.replace(/[^A-Za-z0-9-]/gu, "-").slice(0, 48);
    const target = this.safePath("quarantine", `${safeRun}-${safeKind}-${Date.now()}.json`);
    const record: JsonObject = {
      schema_epoch: "host-quarantine-1.0",
      run_id: safeRun,
      kind: safeKind,
      reason,
      record_digest: digest,
      quarantined_at: now(),
    };
    await this.writeAtomic(target, record);
  }
}
