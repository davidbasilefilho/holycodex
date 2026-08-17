// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  type JsonObject,
} from "@holycodex/core";
import { type } from "arktype";
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
  RunSnapshotSchema,
  type ContinuationClaim,
  type JournalEvent,
  type RunDefinition,
  type RunId,
  type RunSnapshot,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";

export type StoredRun = Readonly<{
  readonly snapshot: RunSnapshot;
  readonly journal: readonly JournalEvent[];
}>;

type AppendLock = Promise<void>;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IGNORED_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF", "ENOSYS"]);
const APPEND_LOCK_TIMEOUT_MS = 5_000;
const APPEND_LOCK_WAIT_MS = 10;

function now(): string {
  return new Date().toISOString();
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
    if (typeof code !== "string" || !IGNORED_FSYNC_CODES.has(code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  await syncPath(path).catch((error: unknown) => {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (typeof code !== "string" || !IGNORED_FSYNC_CODES.has(code)) {
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
  }

  async createRun(snapshot: RunSnapshot, event: JournalEvent): Promise<void> {
    await this.init();
    const parsedSnapshot = RunSnapshotSchema(snapshot);
    const parsedEvent = JournalEventSchema(event);
    if (parsedSnapshot instanceof type.errors) {
      throw new WorkflowHostError("invalid_input", "The run snapshot is invalid.");
    }
    if (parsedEvent instanceof type.errors) {
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
    await this.writeAtomic(snapshotPath, snapshot);
    try {
      await this.appendJournal(snapshot.definition.run_id, event);
    } catch (error) {
      await rm(directory, { recursive: true, force: false }).catch(() => undefined);
      throw error;
    }
  }

  async load(runId: string): Promise<StoredRun> {
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
    let snapshot: RunSnapshot;
    try {
      const snapshotEntry = await lstat(snapshotPath);
      if (snapshotEntry.isSymbolicLink() || !snapshotEntry.isFile()) {
        throw new WorkflowHostError("path_rejected", "The run snapshot is not a regular file.");
      }
      const raw = await readFile(snapshotPath, "utf8");
      const parsedJson: unknown = JSON.parse(raw);
      const parsed = RunSnapshotSchema(parsedJson);
      if (parsed instanceof type.errors || parsed.definition.run_id !== runId) {
        await this.quarantine(runId, "snapshot", "schema validation failed");
        throw new WorkflowHostError("state_corrupt", "The run snapshot is corrupt.");
      }
      snapshot = parsed;
    } catch (error) {
      if (error instanceof WorkflowHostError) {
        throw error;
      }
      await this.quarantine(runId, "snapshot", "snapshot could not be read");
      throw new WorkflowHostError(
        "state_corrupt",
        "The run snapshot is corrupt.",
        {},
        { cause: error },
      );
    }

    const journalPath = join(directory, "journal.ndjson");
    let rawJournal = "";
    let journalMissing = false;
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
      if (!isErrorCode(error, "ENOENT")) {
        await this.quarantine(runId, "journal", "journal could not be read");
        return { snapshot: { ...snapshot, integrity: "uncertain" }, journal: [] };
      }
      journalMissing = true;
    }

    const journal: JournalEvent[] = [];
    let integrity: RunSnapshot["integrity"] = journalMissing ? "uncertain" : snapshot.integrity;
    if (journalMissing) {
      await this.quarantine(runId, "journal", "journal is missing");
    }
    let expectedSequence = 1;
    for (const line of rawJournal.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsedJson: unknown = JSON.parse(line);
        const parsed = JournalEventSchema(parsedJson);
        if (parsed instanceof type.errors) {
          throw new Error("schema validation failed");
        }
        if (parsed.run_id !== runId || parsed.sequence !== expectedSequence) {
          throw new Error("journal identity or sequence mismatch");
        }
        journal.push(parsed);
        expectedSequence += 1;
      } catch {
        integrity = "uncertain";
        await this.quarantine(runId, "journal-record", "journal record was corrupt or ambiguous");
      }
    }
    return {
      snapshot: integrity === snapshot.integrity ? snapshot : { ...snapshot, integrity },
      journal,
    };
  }

  async saveSnapshot(snapshot: RunSnapshot): Promise<void> {
    await this.init();
    const parsed = RunSnapshotSchema(snapshot);
    if (parsed instanceof type.errors) {
      throw new WorkflowHostError("invalid_input", "The run snapshot is invalid.");
    }
    const directory = await this.ensureRunDirectory(snapshot.definition.run_id);
    await this.writeAtomic(join(directory, "snapshot.json"), snapshot);
  }

  async appendJournal(runId: string, event: JournalEvent): Promise<void> {
    await this.init();
    assertValidRunId(runId);
    const parsed = JournalEventSchema(event);
    if (parsed instanceof type.errors || parsed.run_id !== runId) {
      throw new WorkflowHostError("invalid_input", "The journal event does not match the run.");
    }
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
            const existing = JournalEventSchema(existingJson);
            if (
              existing instanceof type.errors ||
              existing.run_id !== runId ||
              existing.sequence !== nextSequence
            ) {
              throw new WorkflowHostError(
                "state_corrupt",
                "The run journal sequence is corrupt or ambiguous.",
              );
            }
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
        if (parsed.sequence !== nextSequence) {
          throw new WorkflowHostError(
            "state_corrupt",
            "The appended journal event is not the next monotonic sequence.",
          );
        }
        if (journalMissing && (parsed.sequence !== 1 || parsed.event !== "run-created")) {
          throw new WorkflowHostError(
            "state_corrupt",
            "A missing run journal cannot be repaired by appending an arbitrary event.",
          );
        }
        const handle = await open(journalPath, "a", 0o600);
        try {
          await handle.writeFile(`${canonicalJson(parsed)}\n`, "utf8");
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
      } finally {
        await lock.release();
      }
    });
    this.appendLocks.set(runId, next);
    try {
      await next;
    } finally {
      if (this.appendLocks.get(runId) === next) {
        this.appendLocks.delete(runId);
      }
    }
  }

  async claimContinuation(claim: ContinuationClaim): Promise<void> {
    await this.init();
    const parsed = ContinuationClaimSchema(claim);
    if (parsed instanceof type.errors) {
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
    const parsedClaim = ContinuationClaimSchema(input.claim);
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
    const parsedSnapshot = RunSnapshotSchema(derivedSnapshot);
    const parsedEvent = JournalEventSchema(derivedEvent);
    if (
      parsedClaim instanceof type.errors ||
      parsedSnapshot instanceof type.errors ||
      parsedEvent instanceof type.errors ||
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
      const parentEvent: JournalEvent = {
        schema_epoch: "host-journal-1.0",
        event: "continuation-claimed",
        run_id: parsedClaim.parent_run_id,
        sequence: (parent.journal.at(-1)?.sequence ?? 0) + 1,
        at: now(),
        claim: parsedClaim,
      };
      await this.appendJournal(parsedClaim.parent_run_id, parentEvent);
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
      await mkdir(safe, { recursive: false, mode: 0o700 });
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
    try {
      await writeFile(temporary, canonicalJson(value), { mode: 0o600 });
      await syncPath(temporary);
      await rename(temporary, path);
      await syncDirectory(directory);
    } catch (error) {
      throw new WorkflowHostError(
        "persistence_failed",
        "The run-store snapshot could not be written.",
        {},
        { cause: error },
      );
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
