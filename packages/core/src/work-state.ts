// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { decode as decodeToon, encode as encodeToon } from "@toon-format/toon";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { ROLE_DEFINITIONS } from "./routes.ts";
import { decodeUnknown } from "./schema.ts";

export const INTENT_SCHEMA_VERSION = "holycodex-intent-1" as const;
export const PLAN_SCHEMA_VERSION = "holycodex-plan-1" as const;
export const ASSIGNMENT_SCHEMA_VERSION = "holycodex-assignment-1" as const;
export const TOON_COMPATIBILITY = "toon-4" as const;

const NonEmpty = Schema.String.pipe(Schema.filter((value) => value.trim().length > 0));
const Identifier = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,95}$/u));
const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const Revision = Schema.Int.pipe(Schema.greaterThanOrEqualTo(1));
const DateText = Schema.String.pipe(Schema.filter((value) => !Number.isNaN(Date.parse(value))));
const StringList = Schema.Array(NonEmpty);

/** Canonical non-Root specialist owner for a bounded Assignment. */
export const AssignmentOwnerSchema = Schema.Struct({
  role: Schema.Literal("Explorer", "Librarian", "Worker", "Reviewer"),
  task: NonEmpty,
}).pipe(
  Schema.filter((owner) =>
    ROLE_DEFINITIONS.some(
      (definition) =>
        definition.role === owner.role && definition.tasks.some((task) => task.name === owner.task),
    ),
  ),
);
export type AssignmentOwner = typeof AssignmentOwnerSchema.Type;

export const EvidenceSchema = Schema.Struct({
  kind: Schema.Literal("changed_path", "check", "repository_fact", "ci", "behavior", "uncertainty"),
  value: NonEmpty,
  result: Schema.optional(Schema.Literal("passed", "failed", "observed", "unknown")),
});
export type IntentEvidence = typeof EvidenceSchema.Type;

export const RepositoryBaselineSchema = Schema.Struct({
  root: NonEmpty,
  git_common_dir: NonEmpty,
  initial_head: NonEmpty,
  expected_head: NonEmpty,
  expected_changes: StringList,
  expected_status_digest: Digest,
  updated_at: DateText,
});
export type RepositoryBaseline = typeof RepositoryBaselineSchema.Type;

export const IntentStateSchema = Schema.Literal(
  "scoping",
  "ready",
  "executing",
  "verifying",
  "reviewing",
  "blocked",
  "needs_root_input",
  "complete",
  "abandoned",
);
export type IntentState = typeof IntentStateSchema.Type;
const ResumeStateSchema = Schema.Literal("scoping", "ready", "executing", "verifying", "reviewing");
const GateSchema = Schema.Struct({
  required: Schema.Boolean,
  status: Schema.Literal("not_required", "missing", "passed", "failed", "accepted", "rejected"),
  evidence: Schema.Array(EvidenceSchema),
});

export const IntentSchema = Schema.Struct({
  schema_version: Schema.Literal(INTENT_SCHEMA_VERSION),
  toon_compatibility: Schema.Literal(TOON_COMPATIBILITY),
  id: Identifier,
  slug: Identifier,
  title: NonEmpty,
  goal: NonEmpty,
  acceptance_criteria: StringList,
  state: IntentStateSchema,
  revision: Revision,
  plan_required: Schema.Boolean,
  active_plan_revision: Schema.optional(Revision),
  active_plan_digest: Schema.optional(Digest),
  blockers: StringList,
  resume_state: Schema.optional(ResumeStateSchema),
  verification: GateSchema,
  review: GateSchema,
  acceptance_met: Schema.Boolean,
  root_readiness: Schema.Boolean,
  evidence: Schema.Array(EvidenceSchema),
  baseline: RepositoryBaselineSchema,
  created_at: DateText,
  updated_at: DateText,
});
export type Intent = typeof IntentSchema.Type;

export const PlanSchema = Schema.Struct({
  schema_version: Schema.Literal(PLAN_SCHEMA_VERSION),
  toon_compatibility: Schema.Literal(TOON_COMPATIBILITY),
  intent_id: Identifier,
  revision: Revision,
  predecessor_digest: Schema.optional(Digest),
  approach: NonEmpty,
  scope: StringList,
  exclusions: StringList,
  assignments: StringList,
  dependencies: StringList,
  architecture: StringList,
  risks: StringList,
  assumptions: StringList,
  open_questions: StringList,
  verification: StringList,
  recovery: StringList,
  updated_at: DateText,
});
export type IntentPlan = typeof PlanSchema.Type;

export const AssignmentOutcomeSchema = Schema.Literal(
  "completed",
  "blocked",
  "needs_root_input",
  "failed",
);
export type AssignmentOutcome = typeof AssignmentOutcomeSchema.Type;
export const AssignmentStatusSchema = Schema.Literal(
  "pending",
  "executing",
  "completed",
  "blocked",
  "needs_root_input",
  "failed",
);
export type AssignmentStatus = typeof AssignmentStatusSchema.Type;
/** Compact durable facts from one concrete Assignment execution. */
export const InvocationSchema = Schema.Struct({
  id: Identifier,
  outcome: AssignmentOutcomeSchema,
  started_at: DateText,
  finished_at: DateText,
  summary: NonEmpty,
  evidence: Schema.Array(EvidenceSchema),
  blocker: Schema.optional(NonEmpty),
  remaining_risk: StringList,
});
export type AssignmentInvocation = typeof InvocationSchema.Type;
export const AssignmentSchema = Schema.Struct({
  schema_version: Schema.Literal(ASSIGNMENT_SCHEMA_VERSION),
  toon_compatibility: Schema.Literal(TOON_COMPATIBILITY),
  intent_id: Identifier,
  id: Identifier,
  objective: NonEmpty,
  owner: AssignmentOwnerSchema,
  scope: StringList,
  constraints: StringList,
  exclusions: StringList,
  dependencies: StringList,
  acceptance_criteria: StringList,
  status: AssignmentStatusSchema,
  revision: Revision,
  invocations: Schema.Array(InvocationSchema),
  evidence: Schema.Array(EvidenceSchema),
  blocker: Schema.optional(NonEmpty),
  remaining_risk: StringList,
  created_at: DateText,
  updated_at: DateText,
});
export type Assignment = typeof AssignmentSchema.Type;

const LegacyIntentSchema = Schema.Struct({
  schema_version: Schema.Literal("holycodex-intent-0"),
  id: Identifier,
  slug: Identifier,
  title: NonEmpty,
  goal: NonEmpty,
  acceptance_criteria: StringList,
  state: IntentStateSchema,
  revision: Revision,
  baseline: RepositoryBaselineSchema,
  created_at: DateText,
  updated_at: DateText,
});

export type StoreErrorCode =
  | "invalid_input"
  | "not_found"
  | "already_exists"
  | "malformed_toon"
  | "schema_invalid"
  | "stale_write"
  | "invalid_transition"
  | "not_ready"
  | "completion_refused"
  | "repository_drift"
  | "archive_conflict"
  | "current_ambiguous"
  | "io_failure";

/** Deterministic failure returned by the persistent work-state boundary. */
export class IntentStoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(
    code: StoreErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "IntentStoreError";
    this.code = code;
    this.details = details;
  }
}

/** Stable repository identity and working-tree observation used for drift checks. */
export interface RepositorySnapshot {
  readonly root: string;
  readonly gitCommonDir: string;
  readonly head: string;
  readonly changedPaths: readonly string[];
  readonly statusDigest: string;
}
/** Dependency injection hooks for deterministic clocks and repository observation. */
export interface IntentStoreOptions {
  readonly now?: () => Date;
  readonly repositorySnapshot?: () => Promise<RepositorySnapshot>;
}
/** User-owned data needed to create a durable Intent. */
export interface CreateIntentInput {
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly planRequired?: boolean | undefined;
  readonly verificationRequired?: boolean | undefined;
  readonly reviewRequired?: boolean | undefined;
}

/** Runtime schema for the input accepted by {@link IntentStore.createIntent}. */
export const CreateIntentInputSchema = Schema.Struct({
  title: NonEmpty,
  goal: NonEmpty,
  acceptanceCriteria: Schema.Array(NonEmpty).pipe(Schema.minItems(1)),
  planRequired: Schema.optional(Schema.Boolean),
  verificationRequired: Schema.optional(Schema.Boolean),
  reviewRequired: Schema.optional(Schema.Boolean),
});
/** Root-owned data used to create or revise the canonical Plan. */
export interface PlanInput {
  readonly approach: string;
  readonly scope?: readonly string[] | undefined;
  readonly exclusions?: readonly string[] | undefined;
  readonly assignments?: readonly string[] | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly architecture?: readonly string[] | undefined;
  readonly risks?: readonly string[] | undefined;
  readonly assumptions?: readonly string[] | undefined;
  readonly openQuestions?: readonly string[] | undefined;
  readonly verification?: readonly string[] | undefined;
  readonly recovery?: readonly string[] | undefined;
}

/** Runtime schema for the input accepted by {@link IntentStore.revisePlan}. */
export const PlanInputSchema = Schema.Struct({
  approach: NonEmpty,
  scope: Schema.optional(Schema.Array(NonEmpty)),
  exclusions: Schema.optional(Schema.Array(NonEmpty)),
  assignments: Schema.optional(Schema.Array(NonEmpty)),
  dependencies: Schema.optional(Schema.Array(NonEmpty)),
  architecture: Schema.optional(Schema.Array(NonEmpty)),
  risks: Schema.optional(Schema.Array(NonEmpty)),
  assumptions: Schema.optional(Schema.Array(NonEmpty)),
  openQuestions: Schema.optional(Schema.Array(NonEmpty)),
  verification: Schema.optional(Schema.Array(NonEmpty)),
  recovery: Schema.optional(Schema.Array(NonEmpty)),
});
/** Bounded specialist contract accepted by the Assignment store operation. */
export interface CreateAssignmentInput {
  readonly id?: string | undefined;
  readonly objective: string;
  readonly owner: Assignment["owner"];
  readonly scope: readonly string[];
  readonly constraints?: readonly string[] | undefined;
  readonly exclusions?: readonly string[] | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly acceptanceCriteria: readonly string[];
}

/** Runtime schema for the input accepted by {@link IntentStore.createAssignment}. */
export const CreateAssignmentInputSchema = Schema.Struct({
  id: Schema.optional(NonEmpty),
  objective: NonEmpty,
  owner: AssignmentOwnerSchema,
  scope: Schema.Array(NonEmpty).pipe(Schema.minItems(1)),
  constraints: Schema.optional(Schema.Array(NonEmpty)),
  exclusions: Schema.optional(Schema.Array(NonEmpty)),
  dependencies: Schema.optional(Schema.Array(NonEmpty)),
  acceptanceCriteria: Schema.Array(NonEmpty).pipe(Schema.minItems(1)),
});
/** Compact terminal outcome and evidence returned by one Assignment invocation. */
export interface AssignmentResultInput {
  readonly invocationId?: string | undefined;
  readonly outcome: AssignmentOutcome;
  readonly startedAt?: string | undefined;
  readonly summary: string;
  readonly evidence?: readonly IntentEvidence[] | undefined;
  readonly blocker?: string | undefined;
  readonly remainingRisk?: readonly string[] | undefined;
}
/** Runtime schema for the input accepted by {@link IntentStore.recordAssignmentResult}. */
export const AssignmentResultInputSchema = Schema.Struct({
  invocationId: Schema.optional(NonEmpty),
  outcome: AssignmentOutcomeSchema,
  startedAt: Schema.optional(NonEmpty),
  summary: NonEmpty,
  evidence: Schema.optional(Schema.Array(EvidenceSchema)),
  blocker: Schema.optional(NonEmpty),
  remainingRisk: Schema.optional(Schema.Array(NonEmpty)),
});
/** Machine-readable reasons a predicate-checked Intent completion was refused. */
export interface CompletionRefusal {
  readonly completed: false;
  readonly reasons: readonly string[];
}

/** Root-owned evidence and gate updates accepted by the Intent store. */
export interface IntentEvidenceInput {
  readonly evidence?: readonly IntentEvidence[] | undefined;
  readonly verification?: "passed" | "failed" | undefined;
  readonly review?: "accepted" | "rejected" | undefined;
  readonly acceptanceMet?: boolean | undefined;
  readonly rootReadiness?: boolean | undefined;
  readonly clearBlockers?: boolean | undefined;
}

/** Runtime schema for Root-owned evidence and gate updates. */
export const IntentEvidenceInputSchema = Schema.Struct({
  evidence: Schema.optional(Schema.Array(EvidenceSchema)),
  verification: Schema.optional(Schema.Literal("passed", "failed")),
  review: Schema.optional(Schema.Literal("accepted", "rejected")),
  acceptanceMet: Schema.optional(Schema.Boolean),
  rootReadiness: Schema.optional(Schema.Boolean),
  clearBlockers: Schema.optional(Schema.Boolean),
});

const execFileAsync = promisify(execFile);

/** Official-TOON backed deterministic repository-local Intent persistence. */
export class IntentStore {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly #now: () => Date;
  readonly #snapshot: () => Promise<RepositorySnapshot>;

  constructor(repositoryRoot: string, options: IntentStoreOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.stateRoot = join(this.repositoryRoot, ".holycodex");
    this.#now = options.now ?? (() => new Date());
    this.#snapshot =
      options.repositorySnapshot ?? (() => readRepositorySnapshot(this.repositoryRoot));
  }

  /** Removes interrupted temporary writes without altering canonical state. */
  async recover(): Promise<readonly string[]> {
    await this.#ensureStateRoot();
    if (!(await exists(this.stateRoot))) return [];
    return await withLock(join(this.stateRoot, ".intent-store"), async () => this.#recoverTemps());
  }

  async #recoverTemps(): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.stateRoot, { recursive: true });
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT")) return [];
      throw storeIo(error);
    }
    const removed: string[] = [];
    for (const entry of entries) {
      const name = basename(entry);
      if (!name.startsWith(".holycodex-write-") || !name.endsWith(".tmp")) continue;
      const temporaryPath = join(this.stateRoot, entry);
      const temporaryDirectory = dirname(temporaryPath);
      if (
        temporaryDirectory !== this.stateRoot &&
        (await exists(join(temporaryDirectory, ".intent-store")))
      )
        continue;
      await assertNoSymlinkAncestors(temporaryPath);
      await rm(temporaryPath, { force: true });
      removed.push(entry);
    }
    return removed.sort();
  }

  async #ensureStateRoot(): Promise<void> {
    try {
      const entry = await lstat(this.stateRoot);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new IntentStoreError(
          "schema_invalid",
          "Repository-local work state must be a real directory.",
          { path: this.stateRoot },
        );
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT")) return;
      throw storeIo(error);
    }
  }

  /** Creates a deterministic repository-local Intent and selects it as current. */
  async createIntent(input: CreateIntentInput): Promise<Intent> {
    const validated = parseSchema(CreateIntentInputSchema, input);
    if (
      !validated.title.trim() ||
      !validated.goal.trim() ||
      validated.acceptanceCriteria.length === 0
    )
      throw invalidInput("Intent title, goal, and acceptance criteria are required.");
    await this.recover();
    await mkdir(this.stateRoot, { recursive: true });
    return await withLock(join(this.stateRoot, ".intent-store"), async () => {
      const snapshot = await this.#snapshot();
      const slug = slugify(validated.title);
      const shortId = sha256(
        [snapshot.root, validated.title.trim(), validated.goal.trim()].join("\0"),
      ).slice(0, 10);
      let directoryName = `${slug}-${shortId}`;
      let collision = 1;
      while (await exists(join(this.stateRoot, directoryName))) {
        collision += 1;
        directoryName = `${slug}-${shortId}-${String(collision).padStart(2, "0")}`;
      }
      const id = `intent-${shortId}${collision === 1 ? "" : `-${String(collision).padStart(2, "0")}`}`;
      const timestamp = this.#now().toISOString();
      const intent = parseSchema(IntentSchema, {
        schema_version: INTENT_SCHEMA_VERSION,
        toon_compatibility: TOON_COMPATIBILITY,
        id,
        slug,
        title: validated.title.trim(),
        goal: validated.goal.trim(),
        acceptance_criteria: [...validated.acceptanceCriteria],
        state: "scoping",
        revision: 1,
        plan_required: validated.planRequired ?? false,
        blockers: [],
        verification: gate(validated.verificationRequired ?? true),
        review: gate(validated.reviewRequired ?? true),
        acceptance_met: false,
        root_readiness: false,
        evidence: [],
        baseline: baselineFromSnapshot(snapshot, timestamp),
        created_at: timestamp,
        updated_at: timestamp,
      });
      const directory = join(this.stateRoot, directoryName);
      await mkdir(join(directory, "assignments"), { recursive: true });
      await atomicWriteToon(join(directory, "intent.toon"), intent);
      await atomicWriteText(join(this.stateRoot, "current"), `${directoryName}\n`);
      return intent;
    });
  }

  /** Lists every validated Intent in deterministic identifier order. */
  async listIntents(): Promise<readonly Intent[]> {
    await this.#ensureStateRoot();
    await this.recover();
    let entries: string[];
    try {
      entries = await readdir(this.stateRoot);
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT")) return [];
      throw storeIo(error);
    }
    const values: Intent[] = [];
    for (const entry of entries.sort()) {
      const directory = join(this.stateRoot, entry);
      if (!(await isDirectory(directory))) continue;
      const path = join(directory, "intent.toon");
      if (await isFile(path)) values.push(await this.#readIntentPath(path));
    }
    return values.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Reads one Intent by identifier, directory name, or unique slug. */
  async readIntent(reference: string): Promise<Intent> {
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () =>
      this.#readIntentPath(join(directory, "intent.toon")),
    );
  }

  /** Resolves the selected current Intent without guessing among multiple active Intents. */
  async currentIntent(): Promise<Intent> {
    await this.#ensureStateRoot();
    try {
      const pointer = join(this.stateRoot, "current");
      const pointerEntry = await lstat(pointer).catch((error: unknown) => {
        if (isFsCode(error, "ENOENT")) return undefined;
        throw storeIo(error);
      });
      if (pointerEntry?.isSymbolicLink() || (pointerEntry && !pointerEntry.isFile()))
        throw new IntentStoreError(
          "schema_invalid",
          "The current Intent pointer must be a regular file.",
        );
      const directory = pointerEntry ? (await readFile(pointer, "utf8")).trim() : "";
      if (directory) {
        const selected = resolve(this.stateRoot, directory);
        if (!isWithin(this.stateRoot, selected))
          throw new IntentStoreError(
            "schema_invalid",
            "The current Intent pointer escapes repository-local state.",
            { directory },
          );
        if (!(await isDirectory(selected)))
          throw new IntentStoreError(
            "schema_invalid",
            "The current Intent pointer does not select a work-state directory.",
            { directory },
          );
        return await this.#readIntentPath(join(selected, "intent.toon"));
      }
    } catch (error: unknown) {
      if (!isFsCode(error, "ENOENT")) throw storeIo(error);
    }
    const active = (await this.listIntents()).filter(
      (value) => value.state !== "complete" && value.state !== "abandoned",
    );
    if (active.length === 1) return active[0]!;
    throw new IntentStoreError(
      active.length ? "current_ambiguous" : "not_found",
      active.length
        ? "Multiple active Intents require explicit selection."
        : "No current Intent exists.",
      { intent_ids: active.map((value) => value.id) },
    );
  }

  /** Selects an existing Intent as current. */
  async selectCurrent(reference: string): Promise<Intent> {
    const directory = await this.#locate(reference);
    const intent = await this.#readIntentPath(join(directory, "intent.toon"));
    await withLock(join(this.stateRoot, ".intent-store"), async () =>
      atomicWriteText(join(this.stateRoot, "current"), `${basename(directory)}\n`),
    );
    return intent;
  }

  /** Applies a guarded lifecycle transition and returns the revised Intent. */
  async transitionIntent(
    reference: string,
    target: IntentState,
    expectedRevision: number,
    blocker?: string,
  ): Promise<Intent> {
    const validatedTarget = parseSchema(IntentStateSchema, target);
    const validatedBlocker = blocker === undefined ? undefined : parseSchema(NonEmpty, blocker);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw invalidInput("Intent revision must be a positive integer.");
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () => {
      const intent = await this.#readIntentPath(join(directory, "intent.toon"));
      assertRevision(intent.revision, expectedRevision);
      if (validatedTarget === "complete")
        throw new IntentStoreError(
          "invalid_transition",
          "Use the predicate-checked complete operation.",
        );
      if (validatedTarget === "abandoned") return await this.#abandonDirectory(directory, intent);
      return await this.#transition(directory, intent, validatedTarget, validatedBlocker);
    });
  }

  /** Predicate-checks and completes an Intent, or returns machine-readable refusal reasons. */
  async completeIntent(
    reference: string,
    expectedRevision: number,
  ): Promise<Intent | CompletionRefusal> {
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () => {
      const intent = await this.#readIntentPath(join(directory, "intent.toon"));
      assertRevision(intent.revision, expectedRevision);
      assertIntentMutable(intent);
      await this.#assertNoDrift(intent);
      if (intent.active_plan_revision !== undefined) await this.readPlan(reference);
      const assignments = await this.listAssignments(reference);
      const reasons: string[] = [];
      if (intent.state !== "reviewing") reasons.push("intent_not_reviewing");
      if (intent.plan_required && intent.active_plan_revision === undefined)
        reasons.push("required_plan_missing");
      if (intent.blockers.length) reasons.push("global_blockers_unresolved");
      if (assignments.length === 0) reasons.push("assignment_required");
      if (assignments.some((value) => value.status !== "completed"))
        reasons.push("assignments_unresolved");
      if (intent.verification.required && intent.verification.status !== "passed")
        reasons.push("verification_unresolved");
      if (intent.review.required && intent.review.status !== "accepted")
        reasons.push("review_unresolved");
      if (!intent.acceptance_met) reasons.push("acceptance_criteria_unmet");
      if (!intent.root_readiness) reasons.push("root_readiness_missing");
      if (reasons.length) return { completed: false, reasons };
      const completed = reviseIntent(intent, this.#now, { state: "complete" });
      await atomicWriteToon(join(directory, "intent.toon"), completed);
      return completed;
    });
  }

  /** Closes incomplete work without representing it as completed. */
  async abandonIntent(reference: string, expectedRevision: number): Promise<Intent> {
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () => {
      const intent = await this.#readIntentPath(join(directory, "intent.toon"));
      assertRevision(intent.revision, expectedRevision);
      return await this.#abandonDirectory(directory, intent);
    });
  }

  /** Records global proof and gate state owned by Root. */
  async recordIntentEvidence(
    reference: string,
    expectedRevision: number,
    input: IntentEvidenceInput,
  ): Promise<Intent> {
    const validated = parseSchema(IntentEvidenceInputSchema, input);
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () => {
      const intent = await this.#readIntentPath(join(directory, "intent.toon"));
      assertRevision(intent.revision, expectedRevision);
      assertIntentMutable(intent);
      if (validated.verification !== undefined || validated.review !== undefined)
        await this.#assertNoDrift(intent);
      if (validated.verification !== undefined && intent.state !== "verifying")
        throw new IntentStoreError(
          "invalid_transition",
          "Verification evidence is only accepted while the Intent is verifying.",
          { state: intent.state },
        );
      if (validated.review !== undefined && intent.state !== "reviewing")
        throw new IntentStoreError(
          "invalid_transition",
          "Review evidence is only accepted while the Intent is reviewing.",
          { state: intent.state },
        );
      const evidence = [...intent.evidence, ...(validated.evidence ?? [])];
      const verification =
        validated.verification === undefined
          ? intent.verification
          : {
              ...intent.verification,
              status: validated.verification,
              evidence: [...intent.verification.evidence, ...(validated.evidence ?? [])],
            };
      const review =
        validated.review === undefined
          ? intent.review
          : {
              ...intent.review,
              status: validated.review,
              evidence: [...intent.review.evidence, ...(validated.evidence ?? [])],
            };
      const state =
        validated.review === "rejected" && intent.state === "reviewing"
          ? "executing"
          : intent.state;
      const revised = reviseIntent(intent, this.#now, {
        state,
        evidence,
        verification,
        review,
        ...(validated.acceptanceMet === undefined
          ? {}
          : { acceptance_met: validated.acceptanceMet }),
        ...(validated.rootReadiness === undefined
          ? {}
          : { root_readiness: validated.rootReadiness }),
        ...(validated.clearBlockers ? { blockers: [] } : {}),
      });
      await atomicWriteToon(join(directory, "intent.toon"), revised);
      return revised;
    });
  }

  /** Reads the optional canonical Plan. */
  async readPlan(reference: string): Promise<IntentPlan | undefined> {
    const directory = await this.#locate(reference);
    const path = join(directory, "plan.toon");
    if (!(await isFile(path))) return undefined;
    const plan = await readValidatedToon(path, PlanSchema);
    const intent = await this.#readIntentPath(join(directory, "intent.toon"));
    const digest = sha256(`${encodeToon(plan)}\n`);
    if (
      plan.intent_id !== intent.id ||
      intent.active_plan_revision !== plan.revision ||
      intent.active_plan_digest !== digest
    )
      throw new IntentStoreError(
        "schema_invalid",
        "Canonical Plan provenance does not match its Intent.",
        {
          intent_id: intent.id,
          plan_revision: plan.revision,
        },
      );
    return plan;
  }

  /** Replaces the canonical Plan while immutably archiving its predecessor. */
  async revisePlan(
    reference: string,
    input: PlanInput,
    expectedIntentRevision: number,
    expectedPlanRevision?: number,
  ): Promise<{ readonly intent: Intent; readonly plan: IntentPlan; readonly archived?: string }> {
    const validated = parseSchema(PlanInputSchema, input);
    if (!validated.approach.trim()) throw invalidInput("Plan approach is required.");
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () => {
      const intent = await this.#readIntentPath(join(directory, "intent.toon"));
      assertRevision(intent.revision, expectedIntentRevision);
      assertIntentMutable(intent);
      await this.#assertNoDrift(intent);
      const planPath = join(directory, "plan.toon");
      const current = (await isFile(planPath))
        ? await readValidatedToon(planPath, PlanSchema)
        : undefined;
      if (current === undefined && expectedPlanRevision !== undefined)
        assertRevision(0, expectedPlanRevision);
      if (current !== undefined) assertRevision(current.revision, expectedPlanRevision);
      let archived: string | undefined;
      let predecessorDigest: string | undefined;
      if (current) {
        const text = `${encodeToon(current)}\n`;
        predecessorDigest = sha256(text);
        archived = await nextArchivePath(directory);
        await immutableWrite(archived, text);
      }
      const plan = parseSchema(PlanSchema, {
        schema_version: PLAN_SCHEMA_VERSION,
        toon_compatibility: TOON_COMPATIBILITY,
        intent_id: intent.id,
        revision: (current?.revision ?? 0) + 1,
        ...(predecessorDigest ? { predecessor_digest: predecessorDigest } : {}),
        approach: validated.approach.trim(),
        scope: [...(validated.scope ?? [])],
        exclusions: [...(validated.exclusions ?? [])],
        assignments: [...(validated.assignments ?? [])],
        dependencies: [...(validated.dependencies ?? [])],
        architecture: [...(validated.architecture ?? [])],
        risks: [...(validated.risks ?? [])],
        assumptions: [...(validated.assumptions ?? [])],
        open_questions: [...(validated.openQuestions ?? [])],
        verification: [...(validated.verification ?? [])],
        recovery: [...(validated.recovery ?? [])],
        updated_at: this.#now().toISOString(),
      });
      await atomicWriteToon(planPath, plan);
      const digest = sha256(`${encodeToon(plan)}\n`);
      const revisedIntent = reviseIntent(intent, this.#now, {
        active_plan_revision: plan.revision,
        active_plan_digest: digest,
        verification: resetGate(intent.verification),
        review: resetGate(intent.review),
        acceptance_met: false,
        root_readiness: false,
      });
      await atomicWriteToon(join(directory, "intent.toon"), revisedIntent);
      return { intent: revisedIntent, plan, ...(archived ? { archived: basename(archived) } : {}) };
    });
  }

  /** Creates a bounded Assignment after validating the repository baseline. */
  async createAssignment(
    reference: string,
    input: CreateAssignmentInput,
    expectedIntentRevision: number,
  ): Promise<Assignment> {
    const validated = parseSchema(CreateAssignmentInputSchema, input);
    if (
      !validated.objective.trim() ||
      validated.scope.length === 0 ||
      validated.acceptanceCriteria.length === 0
    )
      throw invalidInput("Assignment objective, scope, and acceptance criteria are required.");
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () => {
      const intent = await this.#readIntentPath(join(directory, "intent.toon"));
      assertRevision(intent.revision, expectedIntentRevision);
      assertIntentMutable(intent);
      await this.#assertNoDrift(intent);
      const id =
        validated.id ??
        `assignment-${sha256([intent.id, validated.objective, ...validated.scope].join("\0")).slice(0, 10)}`;
      if (!/^[a-z0-9][a-z0-9-]{0,95}$/u.test(id)) throw invalidInput("Assignment id is invalid.");
      const path = join(directory, "assignments", `${id}.toon`);
      if (await exists(path))
        throw new IntentStoreError("already_exists", "Assignment already exists.", { id });
      const timestamp = this.#now().toISOString();
      const assignment = parseSchema(AssignmentSchema, {
        schema_version: ASSIGNMENT_SCHEMA_VERSION,
        toon_compatibility: TOON_COMPATIBILITY,
        intent_id: intent.id,
        id,
        objective: validated.objective.trim(),
        owner: validated.owner,
        scope: [...validated.scope],
        constraints: [...(validated.constraints ?? [])],
        exclusions: [...(validated.exclusions ?? [])],
        dependencies: [...(validated.dependencies ?? [])],
        acceptance_criteria: [...validated.acceptanceCriteria],
        status: "pending",
        revision: 1,
        invocations: [],
        evidence: [],
        remaining_risk: [],
        created_at: timestamp,
        updated_at: timestamp,
      });
      await mkdir(dirname(path), { recursive: true });
      await atomicWriteToon(path, assignment);
      return assignment;
    });
  }

  /** Reads one Assignment. */
  async readAssignment(reference: string, assignmentId: string): Promise<Assignment> {
    const validatedId = parseSchema(Identifier, assignmentId);
    const directory = await this.#locate(reference);
    const intent = await this.#readIntentPath(join(directory, "intent.toon"));
    const assignmentsRoot = join(directory, "assignments");
    await assertDirectory(assignmentsRoot, true);
    const path = join(assignmentsRoot, `${validatedId}.toon`);
    if (!(await isFile(path)))
      throw new IntentStoreError("not_found", "Assignment was not found.", {
        assignment_id: validatedId,
      });
    const assignment = await readValidatedToon(path, AssignmentSchema);
    assertAssignmentIdentity(assignment, intent.id, validatedId, path);
    return assignment;
  }

  /** Lists validated Assignments in deterministic identifier order. */
  async listAssignments(reference: string): Promise<readonly Assignment[]> {
    const directory = await this.#locate(reference);
    const intent = await this.#readIntentPath(join(directory, "intent.toon"));
    const root = join(directory, "assignments");
    if (!(await assertDirectory(root, true))) return [];
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT")) return [];
      throw storeIo(error);
    }
    const assignments = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".toon"))
        .sort()
        .map(async (entry) => {
          const path = join(root, entry);
          const assignment = await readValidatedToon(path, AssignmentSchema);
          const expectedId = entry.slice(0, -".toon".length);
          assertAssignmentIdentity(assignment, intent.id, expectedId, path);
          return assignment;
        }),
    );
    return assignments;
  }

  /** Starts or retries an Assignment invocation. */
  async startAssignment(
    reference: string,
    assignmentId: string,
    expectedRevision: number,
  ): Promise<Assignment> {
    const validatedId = parseSchema(Identifier, assignmentId);
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () => {
      const intent = await this.#readIntentPath(join(directory, "intent.toon"));
      assertIntentMutable(intent);
      await this.#assertNoDrift(intent);
      const assignment = await this.readAssignment(reference, validatedId);
      assertRevision(assignment.revision, expectedRevision);
      if (assignment.status === "completed")
        throw new IntentStoreError(
          "invalid_transition",
          "A completed Assignment cannot be restarted.",
        );
      const revised = reviseAssignment(assignment, this.#now, {
        status: "executing",
        blocker: undefined,
      });
      await atomicWriteToon(join(directory, "assignments", `${validatedId}.toon`), revised);
      return revised;
    });
  }

  /** Appends one compact invocation result and its observable evidence. */
  async recordAssignmentResult(
    reference: string,
    assignmentId: string,
    expectedRevision: number,
    input: AssignmentResultInput,
  ): Promise<{ readonly assignment: Assignment; readonly intent: Intent }> {
    const validated = parseSchema(AssignmentResultInputSchema, input);
    const validatedId = parseSchema(Identifier, assignmentId);
    const directory = await this.#locate(reference);
    return await this.#withIntentLock(directory, async () => {
      const intent = await this.#readIntentPath(join(directory, "intent.toon"));
      assertIntentMutable(intent);
      const assignment = await this.readAssignment(reference, validatedId);
      assertRevision(assignment.revision, expectedRevision);
      if (!["executing", "blocked", "needs_root_input", "failed"].includes(assignment.status))
        throw new IntentStoreError(
          "invalid_transition",
          `Assignment result is invalid from ${assignment.status}.`,
        );
      if (
        (validated.outcome === "blocked" || validated.outcome === "needs_root_input") &&
        !validated.blocker?.trim()
      )
        throw invalidInput("Blocked results require a local blocker.");
      const snapshot = await this.#snapshot();
      const evidence = [...(validated.evidence ?? [])];
      const declared = new Set(
        evidence.filter((item) => item.kind === "changed_path").map((item) => item.value),
      );
      const outOfScope = [...declared].filter(
        (path) => !assignment.scope.some((scope) => pathWithinAssignmentScope(path, scope)),
      );
      if (outOfScope.length)
        throw new IntentStoreError(
          "repository_drift",
          "Assignment evidence declares paths outside its bounded scope.",
          { assignment_id: assignment.id, out_of_scope_paths: outOfScope.sort() },
        );
      const allowed = new Set([...intent.baseline.expected_changes, ...declared]);
      const unexpected = snapshot.changedPaths.filter((path) => !allowed.has(path));
      const identityChanged =
        snapshot.root !== intent.baseline.root ||
        snapshot.gitCommonDir !== intent.baseline.git_common_dir;
      const statusChanged =
        normalizeStatusDigest(snapshot.statusDigest) !== intent.baseline.expected_status_digest;
      const observedDeclaration = [...declared].some((path) =>
        snapshot.changedPaths.includes(path),
      );
      // Root-owned integration may advance HEAD before a result is recorded,
      // but only an explicitly declared Assignment evolution may explain it.
      if (
        identityChanged ||
        unexpected.length ||
        (statusChanged && !observedDeclaration) ||
        (snapshot.head !== intent.baseline.expected_head && !observedDeclaration)
      ) {
        throw new IntentStoreError(
          "repository_drift",
          "Repository state changed outside the recorded Assignment result.",
          {
            expected_head: intent.baseline.expected_head,
            actual_head: snapshot.head,
            unexpected_paths: unexpected,
          },
        );
      }
      const timestamp = this.#now().toISOString();
      const invocationId =
        validated.invocationId ??
        `invocation-${String(assignment.invocations.length + 1).padStart(3, "0")}`;
      if (assignment.invocations.some((value) => value.id === invocationId))
        throw new IntentStoreError("already_exists", "Assignment invocation already exists.", {
          invocation_id: invocationId,
        });
      const invocation = parseSchema(InvocationSchema, {
        id: invocationId,
        outcome: validated.outcome,
        started_at: validated.startedAt ?? timestamp,
        finished_at: timestamp,
        summary: validated.summary,
        evidence,
        ...(validated.blocker ? { blocker: validated.blocker } : {}),
        remaining_risk: [...(validated.remainingRisk ?? [])],
      });
      const revised = reviseAssignment(assignment, this.#now, {
        status: validated.outcome,
        invocations: [...assignment.invocations, invocation],
        evidence: [...assignment.evidence, ...evidence],
        blocker: validated.blocker,
        remaining_risk: [...(validated.remainingRisk ?? [])],
      });
      await atomicWriteToon(join(directory, "assignments", `${validatedId}.toon`), revised);
      const revisedIntent = reviseIntent(intent, this.#now, {
        baseline: baselineFromSnapshot(snapshot, timestamp, intent.baseline.initial_head),
        verification: resetGate(intent.verification),
        review: resetGate(intent.review),
        acceptance_met: false,
        root_readiness: false,
      });
      await atomicWriteToon(join(directory, "intent.toon"), revisedIntent);
      return { assignment: revised, intent: revisedIntent };
    });
  }

  async #transition(
    directory: string,
    intent: Intent,
    target: IntentState,
    blocker?: string,
  ): Promise<Intent> {
    const source = intent.state;
    if (target === "blocked" || target === "needs_root_input") {
      if (["complete", "abandoned", "blocked", "needs_root_input"].includes(source))
        throw invalidTransition(source, target);
      if (!blocker?.trim()) throw invalidInput("A blocker or required input is required.");
      const revised = reviseIntent(intent, this.#now, {
        state: target,
        blockers: [blocker.trim()],
        resume_state: source as typeof ResumeStateSchema.Type,
      });
      await atomicWriteToon(join(directory, "intent.toon"), revised);
      return revised;
    }
    if (source === "blocked" || source === "needs_root_input") {
      if (target !== intent.resume_state || intent.blockers.length)
        throw invalidTransition(source, target);
    } else {
      const allowed: Readonly<Record<string, readonly IntentState[]>> = {
        scoping: ["ready"],
        ready: ["executing"],
        executing: ["verifying"],
        verifying: ["reviewing", "executing"],
        reviewing: ["executing"],
      };
      if (!allowed[source]?.includes(target)) throw invalidTransition(source, target);
    }
    if (target === "ready") {
      const reasons: string[] = [];
      if (!intent.goal.trim()) reasons.push("goal_missing");
      if (!intent.acceptance_criteria.length) reasons.push("acceptance_criteria_missing");
      if (intent.plan_required && intent.active_plan_revision === undefined)
        reasons.push("required_plan_missing");
      const plan =
        intent.active_plan_revision === undefined ? undefined : await this.readPlan(intent.id);
      if (plan?.open_questions.length) reasons.push("material_open_questions");
      if (reasons.length)
        throw new IntentStoreError("not_ready", "Intent readiness predicates failed.", { reasons });
    }
    if (target === "executing" && source === "ready") await this.#assertNoDrift(intent);
    if (
      target === "reviewing" &&
      intent.verification.required &&
      intent.verification.status !== "passed"
    )
      throw new IntentStoreError("invalid_transition", "Verification must pass before review.");
    if (target === "reviewing") await this.#assertNoDrift(intent);
    const revised = reviseIntent(intent, this.#now, { state: target, resume_state: undefined });
    await atomicWriteToon(join(directory, "intent.toon"), revised);
    return revised;
  }

  async #withIntentLock<A>(directory: string, operation: () => Promise<A>): Promise<A> {
    return await withLock(join(directory, ".intent-store"), operation);
  }

  async #abandonDirectory(directory: string, intent: Intent): Promise<Intent> {
    if (intent.state === "complete" || intent.state === "abandoned")
      throw invalidTransition(intent.state, "abandoned");
    const abandoned = reviseIntent(intent, this.#now, { state: "abandoned", blockers: [] });
    await atomicWriteToon(join(directory, "intent.toon"), abandoned);
    return abandoned;
  }

  async #assertNoDrift(intent: Intent): Promise<void> {
    const snapshot = await this.#snapshot();
    const expected = [...intent.baseline.expected_changes].sort();
    const actual = [...snapshot.changedPaths].sort();
    if (
      snapshot.root !== intent.baseline.root ||
      snapshot.gitCommonDir !== intent.baseline.git_common_dir ||
      snapshot.head !== intent.baseline.expected_head ||
      normalizeStatusDigest(snapshot.statusDigest) !== intent.baseline.expected_status_digest ||
      expected.join("\0") !== actual.join("\0")
    ) {
      throw new IntentStoreError(
        "repository_drift",
        "Repository baseline no longer matches recorded assumptions.",
        {
          expected_head: intent.baseline.expected_head,
          actual_head: snapshot.head,
          expected_changes: expected,
          actual_changes: actual,
        },
      );
    }
  }

  async #locate(reference: string): Promise<string> {
    await this.#ensureStateRoot();
    let entries: string[];
    try {
      entries = await readdir(this.stateRoot);
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT"))
        throw new IntentStoreError("not_found", "Intent was not found.", { reference });
      throw storeIo(error);
    }
    const matches: string[] = [];
    for (const entry of entries.sort()) {
      const directory = join(this.stateRoot, entry);
      if (!(await isDirectory(directory))) continue;
      const path = join(directory, "intent.toon");
      if (!(await isFile(path))) continue;
      const intent = await this.#readIntentPath(path);
      if (intent.id === reference || intent.slug === reference || entry === reference)
        matches.push(directory);
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new IntentStoreError("current_ambiguous", "Intent reference is ambiguous.", {
        reference,
      });
    throw new IntentStoreError("not_found", "Intent was not found.", { reference });
  }

  async #readIntentPath(path: string): Promise<Intent> {
    const decoded = await readRawToon(path);
    const current = decodeUnknown(IntentSchema, decoded);
    if (Either.isRight(current)) return current.right;
    const legacy = decodeUnknown(LegacyIntentSchema, decoded);
    if (Either.isLeft(legacy))
      throw new IntentStoreError("schema_invalid", "Persisted Intent failed schema validation.", {
        path,
        error: String(current.left),
      });
    const migrated = migrateLegacyIntent(legacy.right);
    await atomicWriteToon(path, migrated);
    return migrated;
  }
}

/** Captures stable repository identity and current working state. */
export async function readRepositorySnapshot(repositoryRoot: string): Promise<RepositorySnapshot> {
  const root = await realpath(repositoryRoot);
  const runGit = async (...args: string[]): Promise<string> => {
    try {
      return (
        await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" })
      ).stdout.trim();
    } catch (error: unknown) {
      throw new IntentStoreError(
        "io_failure",
        "Repository identity requires an accessible Git worktree.",
        { message: error instanceof Error ? error.message : String(error) },
      );
    }
  };
  const common = await runGit("rev-parse", "--git-common-dir");
  const head = (await runGitOptional(root, "rev-parse", "--verify", "HEAD")) ?? "unborn";
  const status = await runGit("status", "--porcelain=v1", "--untracked-files=all");
  const changedPaths = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1)!)
    .sort();
  return {
    root,
    gitCommonDir: resolve(root, common),
    head,
    changedPaths,
    statusDigest: sha256(status),
  };
}

async function runGitOptional(root: string, ...args: string[]): Promise<string | undefined> {
  try {
    return (await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
  } catch {
    return undefined;
  }
}

function migrateLegacyIntent(legacy: typeof LegacyIntentSchema.Type): Intent {
  return parseSchema(IntentSchema, {
    ...legacy,
    schema_version: INTENT_SCHEMA_VERSION,
    toon_compatibility: TOON_COMPATIBILITY,
    plan_required: false,
    blockers: [],
    verification: gate(true),
    review: gate(true),
    acceptance_met: false,
    root_readiness: false,
    evidence: [],
  });
}
function gate(required: boolean): typeof GateSchema.Type {
  return { required, status: required ? "missing" : "not_required", evidence: [] };
}
function resetGate(value: typeof GateSchema.Type): typeof GateSchema.Type {
  return { ...value, status: value.required ? "missing" : "not_required" };
}
function baselineFromSnapshot(
  snapshot: RepositorySnapshot,
  timestamp: string,
  initialHead = snapshot.head,
): RepositoryBaseline {
  return {
    root: snapshot.root,
    git_common_dir: snapshot.gitCommonDir,
    initial_head: initialHead,
    expected_head: snapshot.head,
    expected_changes: [...snapshot.changedPaths].sort(),
    expected_status_digest: /^[a-f0-9]{64}$/u.test(snapshot.statusDigest)
      ? snapshot.statusDigest
      : sha256(snapshot.statusDigest),
    updated_at: timestamp,
  };
}
function normalizeStatusDigest(value: string): string {
  return /^[a-f0-9]{64}$/u.test(value) ? value : sha256(value);
}
function reviseIntent(intent: Intent, now: () => Date, patch: Partial<Intent>): Intent {
  return parseSchema(
    IntentSchema,
    cleanUndefined({
      ...intent,
      ...patch,
      revision: intent.revision + 1,
      updated_at: now().toISOString(),
    }),
  );
}
function reviseAssignment(
  value: Assignment,
  now: () => Date,
  patch: Partial<Assignment>,
): Assignment {
  return parseSchema(
    AssignmentSchema,
    cleanUndefined({
      ...value,
      ...patch,
      revision: value.revision + 1,
      updated_at: now().toISOString(),
    }),
  );
}
function cleanUndefined(value: object): object {
  const cleaned: Record<string, unknown> = { ...value };
  for (const [key, entry] of Object.entries(cleaned)) if (entry === undefined) delete cleaned[key];
  return cleaned;
}
function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48)
    .replace(/-$/u, "");
  return slug || "intent";
}
function pathWithinAssignmentScope(path: string, scope: string): boolean {
  const normalizedPath = normalizeRepositoryPath(path);
  const normalizedScope = normalizeRepositoryPath(scope).replace(/\/+$/u, "");
  if (
    !normalizedPath ||
    !normalizedScope ||
    normalizedPath.startsWith("/") ||
    normalizedScope.startsWith("/") ||
    /^[a-z]:\//u.test(normalizedPath) ||
    /^[a-z]:\//u.test(normalizedScope) ||
    normalizedPath.split("/").includes("..") ||
    normalizedScope.split("/").includes("..")
  )
    return false;
  return (
    normalizedScope === "." ||
    normalizedPath === normalizedScope ||
    normalizedPath.startsWith(`${normalizedScope}/`)
  );
}
function normalizeRepositoryPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
function assertRevision(actual: number, expected: number | undefined): void {
  if (expected === undefined || actual !== expected)
    throw new IntentStoreError("stale_write", "Persisted revision changed before mutation.", {
      expected_revision: expected,
      actual_revision: actual,
    });
}
function invalidInput(message: string): IntentStoreError {
  return new IntentStoreError("invalid_input", message);
}
function assertIntentMutable(intent: Intent): void {
  if (intent.state === "complete" || intent.state === "abandoned")
    throw new IntentStoreError("invalid_transition", "Terminal Intents cannot be mutated.", {
      state: intent.state,
    });
}
function invalidTransition(source: IntentState, target: IntentState): IntentStoreError {
  return new IntentStoreError(
    "invalid_transition",
    `Intent cannot transition from ${source} to ${target}.`,
    { source, target },
  );
}
function parseSchema<A, I>(schema: Schema.Schema<A, I>, value: unknown): A {
  const decoded = decodeUnknown(schema, value);
  if (Either.isLeft(decoded))
    throw new IntentStoreError("schema_invalid", "Value failed Effect Schema validation.", {
      error: String(decoded.left),
    });
  return decoded.right;
}
async function readRawToon(path: string): Promise<unknown> {
  let text: string;
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile())
      throw new IntentStoreError(
        "schema_invalid",
        "Persistent work state must be a regular file.",
        { path },
      );
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT"))
      throw new IntentStoreError("not_found", "Persistent work state was not found.", { path });
    throw storeIo(error);
  }
  try {
    return decodeToon(text, { strict: true });
  } catch (error: unknown) {
    throw new IntentStoreError("malformed_toon", "Persistent work state is malformed TOON.", {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
async function readValidatedToon<A, I>(path: string, schema: Schema.Schema<A, I>): Promise<A> {
  return parseSchema(schema, await readRawToon(path));
}
async function atomicWriteToon(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${encodeToon(value)}\n`);
}
async function atomicWriteText(path: string, text: string): Promise<void> {
  await assertNoSymlinkAncestors(path);
  await mkdir(dirname(path), { recursive: true });
  await assertNoSymlinkAncestors(path);
  const temporary = join(
    dirname(path),
    `.holycodex-write-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw storeIo(error);
  }
}
async function immutableWrite(path: string, text: string): Promise<void> {
  await assertNoSymlinkAncestors(path);
  try {
    const handle = await open(path, "wx", 0o400);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  } catch (error: unknown) {
    if (isFsCode(error, "EEXIST"))
      throw new IntentStoreError("archive_conflict", "Archived plans are immutable.", { path });
    throw storeIo(error);
  }
}

/**
 * Flush a containing directory when the platform exposes directory fsync. Windows can open a
 * directory handle, but its FlushFileBuffers/fsync operation is not a portable durability boundary;
 * file flush and atomic rename remain the durable boundary there.
 */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error: unknown) {
    if (
      isFsCode(error, "EINVAL") ||
      isFsCode(error, "ENOSYS") ||
      isFsCode(error, "ENOTSUP") ||
      isFsCode(error, "EOPNOTSUPP") ||
      isFsCode(error, "EISDIR")
    ) {
      return;
    }
    throw error;
  }
}

/** Serializes a mutation with an exclusive directory lock. */
async function withLock<A>(lockPath: string, operation: () => Promise<A>): Promise<A> {
  const parent = dirname(lockPath);
  await assertNoSymlinkAncestors(lockPath);
  await mkdir(parent, { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath);
      acquired = true;
      break;
    } catch (error: unknown) {
      if (!isFsCode(error, "EEXIST")) throw storeIo(error);
      try {
        const lockEntry = await lstat(lockPath);
        if (lockEntry.isSymbolicLink() || !lockEntry.isDirectory())
          throw new IntentStoreError(
            "schema_invalid",
            "The work-state lock must be a real directory.",
            { path: lockPath },
          );
        const lock = lockEntry;
        if (Date.now() - lock.mtimeMs > 120_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError: unknown) {
        if (!isFsCode(lockError, "ENOENT")) throw storeIo(lockError);
      }
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, Math.min(5 + attempt, 50)),
      );
    }
  }
  if (!acquired)
    throw new IntentStoreError("stale_write", "Another mutation is still in progress.", {
      lock: lockPath,
    });
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
async function nextArchivePath(directory: string): Promise<string> {
  const indexes = (await readdir(directory))
    .map((entry) => /^plan\.old-(\d{3})\.toon$/u.exec(entry)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return join(
    directory,
    `plan.old-${String((indexes.length ? Math.max(...indexes) : 0) + 1).padStart(3, "0")}.toon`,
  );
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return false;
    throw storeIo(error);
  }
}
async function isFile(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT") || isFsCode(error, "ENOTDIR")) return false;
    throw storeIo(error);
  }
}
async function assertDirectory(path: string, allowMissing: boolean): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new IntentStoreError(
        "schema_invalid",
        "Persistent work-state directories must be real directories.",
        { path },
      );
    return true;
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT") && allowMissing) return false;
    throw storeIo(error);
  }
}
async function isDirectory(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT") || isFsCode(error, "ENOTDIR")) return false;
    throw storeIo(error);
  }
}
function assertAssignmentIdentity(
  assignment: Assignment,
  intentId: string,
  expectedId: string,
  path: string,
): void {
  if (assignment.intent_id !== intentId || assignment.id !== expectedId)
    throw new IntentStoreError(
      "schema_invalid",
      "Assignment provenance does not match its Intent or file name.",
      {
        path,
        expected_intent_id: intentId,
        actual_intent_id: assignment.intent_id,
        expected_assignment_id: expectedId,
        actual_assignment_id: assignment.id,
      },
    );
}
async function assertNoSymlinkAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink())
        throw new IntentStoreError(
          "schema_invalid",
          "Persistent work state must not contain symbolic links.",
          { path: current },
        );
    } catch (error: unknown) {
      if (!isFsCode(error, "ENOENT")) throw storeIo(error);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function isFsCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function storeIo(error: unknown): IntentStoreError {
  return error instanceof IntentStoreError
    ? error
    : new IntentStoreError("io_failure", "Persistent work-state I/O failed.", {
        message: error instanceof Error ? error.message : String(error),
      });
}
function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return (
    child === "" ||
    (!child.startsWith(`..${requirePathSeparator()}`) && child !== ".." && !isAbsolute(child))
  );
}
function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
