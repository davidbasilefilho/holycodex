// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { Context7EvidenceSchema, type Context7Evidence } from "./envelopes.ts";
import { context7RequiredForAssignment, ROLE_DEFINITIONS } from "./routes.ts";
import { decodeUnknown } from "./schema.ts";
/** Canonical intent schema version used by core domain operations. */
export const INTENT_SCHEMA_VERSION = "holycodex-intent-1" as const;
/** Canonical plan schema version used by core domain operations. */
export const PLAN_SCHEMA_VERSION = "holycodex-plan-1" as const;
/** Canonical assignment schema version used by core domain operations. */
export const ASSIGNMENT_SCHEMA_VERSION = "holycodex-assignment-1" as const;
/** Canonical toon compatibility used by core domain operations. */
export const TOON_COMPATIBILITY = "toon-4" as const;
const NonEmpty = Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0));
const Identifier = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,95}$/u));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const CommitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const DateText = Schema.String.check(
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value))),
);
const StringList = Schema.Array(NonEmpty);
const LockOwnerSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  token: NonEmpty,
});
type LockOwner = typeof LockOwnerSchema.Type;
const LOCK_STALE_MS = 120000;
const WINDOWS_PID_MAX = 4294967295;
/** Canonical non-Root specialist owner for a bounded Assignment. */
export const AssignmentOwnerSchema = Schema.Struct({
  role: Schema.Literals(["Explorer", "Librarian", "Worker", "Reviewer"]),
  task: NonEmpty,
}).check(
  Schema.makeFilter((owner) =>
    ROLE_DEFINITIONS.some(
      (definition) =>
        definition.role === owner.role && definition.tasks.some((task) => task.name === owner.task),
    ),
  ),
);
/** Type representing assignment owner in the core domain. */
export type AssignmentOwner = typeof AssignmentOwnerSchema.Type;
/** Runtime schema validating evidence values at the receiving boundary. */
export const EvidenceSchema = Schema.Struct({
  kind: Schema.Literals([
    "changed_path",
    "check",
    "repository_fact",
    "ci",
    "behavior",
    "uncertainty",
  ]),
  value: NonEmpty,
  result: Schema.optional(Schema.Literals(["passed", "failed", "observed", "unknown"])),
});
/** Type representing intent evidence in the core domain. */
export type IntentEvidence = typeof EvidenceSchema.Type;
/** Runtime schema validating repository baseline values at the receiving boundary. */
export const RepositoryBaselineSchema = Schema.Struct({
  root: NonEmpty,
  git_common_dir: NonEmpty,
  initial_head: NonEmpty,
  expected_head: NonEmpty,
  expected_changes: StringList,
  expected_status_digest: Digest,
  integrated_commit: Schema.optional(CommitSha),
  updated_at: DateText,
});
/** Type representing repository baseline in the core domain. */
export type RepositoryBaseline = typeof RepositoryBaselineSchema.Type;
/** Runtime schema validating intent state values at the receiving boundary. */
export const IntentStateSchema = Schema.Literals([
  "scoping",
  "ready",
  "executing",
  "verifying",
  "reviewing",
  "blocked",
  "needs_root_input",
  "complete",
  "abandoned",
]);
/** Type representing intent state in the core domain. */
export type IntentState = typeof IntentStateSchema.Type;
const ResumeStateSchema = Schema.Literals([
  "scoping",
  "ready",
  "executing",
  "verifying",
  "reviewing",
]);
const GateSchema = Schema.Struct({
  required: Schema.Boolean,
  status: Schema.Literals(["not_required", "missing", "passed", "failed", "accepted", "rejected"]),
  evidence: Schema.Array(EvidenceSchema),
});
/** Runtime schema validating intent values at the receiving boundary. */
export const IntentSchema = Schema.Struct({
  schema_version: Schema.Literals([INTENT_SCHEMA_VERSION]),
  toon_compatibility: Schema.Literals([TOON_COMPATIBILITY]),
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
/** Type representing intent in the core domain. */
export type Intent = typeof IntentSchema.Type;
/** Runtime schema validating plan values at the receiving boundary. */
export const PlanSchema = Schema.Struct({
  schema_version: Schema.Literals([PLAN_SCHEMA_VERSION]),
  toon_compatibility: Schema.Literals([TOON_COMPATIBILITY]),
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
/** Type representing intent plan in the core domain. */
export type IntentPlan = typeof PlanSchema.Type;
/** Runtime schema validating assignment outcome values at the receiving boundary. */
export const AssignmentOutcomeSchema = Schema.Literals([
  "completed",
  "blocked",
  "needs_root_input",
  "failed",
]);
/** Type representing assignment outcome in the core domain. */
export type AssignmentOutcome = typeof AssignmentOutcomeSchema.Type;
/** Runtime schema validating assignment status values at the receiving boundary. */
export const AssignmentStatusSchema = Schema.Literals([
  "pending",
  "executing",
  "completed",
  "blocked",
  "needs_root_input",
  "failed",
  "superseded",
]);
/** Type representing assignment status in the core domain. */
export type AssignmentStatus = typeof AssignmentStatusSchema.Type;
/** Compact durable facts from one concrete Assignment execution. */
export const InvocationSchema = Schema.Struct({
  id: Identifier,
  outcome: AssignmentOutcomeSchema,
  started_at: DateText,
  finished_at: DateText,
  summary: NonEmpty,
  evidence: Schema.Array(EvidenceSchema),
  context7: Schema.optional(Context7EvidenceSchema),
  blocker: Schema.optional(NonEmpty),
  remaining_risk: StringList,
});
/** Type representing assignment invocation in the core domain. */
export type AssignmentInvocation = typeof InvocationSchema.Type;
/** Opaque capability bound to one active Assignment invocation. */
export const AssignmentInvocationCapabilitySchema = Digest;
/** Type representing assignment invocation capability in the core domain. */
export type AssignmentInvocationCapability = typeof AssignmentInvocationCapabilitySchema.Type;
const AssignmentFields = {
  schema_version: Schema.Literals([ASSIGNMENT_SCHEMA_VERSION]),
  toon_compatibility: Schema.Literals([TOON_COMPATIBILITY]),
  intent_id: Identifier,
  id: Identifier,
  objective: NonEmpty,
  owner: Schema.Union([
    AssignmentOwnerSchema,
    Schema.Struct({ role: Schema.Literals(["Reviewer"]), task: Schema.Literals(["plan"]) }),
  ]),
  scope: StringList,
  constraints: StringList,
  exclusions: StringList,
  dependencies: StringList,
  acceptance_criteria: StringList,
  status: AssignmentStatusSchema,
  revision: Revision,
  invocations: Schema.Array(InvocationSchema),
  /** Invocation correlation for work currently in flight; absent on legacy records. */
  active_invocation_id: Schema.optional(NonEmpty),
  active_started_at: Schema.optional(DateText),
  /** Predecessor Assignment replaced by this one, when supersession was explicit. */
  supersedes: Schema.optional(Identifier),
  /** Replacement Assignment that superseded this one, when supersession was explicit. */
  superseded_by: Schema.optional(Identifier),
  /** Explicit reason recorded on both ends of a supersession relation. */
  supersession_reason: Schema.optional(NonEmpty),
  /** Provenance for the Root decision that established the relation. */
  supersession_provenance: Schema.optional(NonEmpty),
  evidence: Schema.Array(EvidenceSchema),
  blocker: Schema.optional(NonEmpty),
  remaining_risk: StringList,
  created_at: DateText,
  updated_at: DateText,
} as const;
/** Public Assignment projection; protected invocation capabilities are deliberately omitted. */
export const AssignmentSchema = Schema.Struct(AssignmentFields);
/** Type representing assignment in the core domain. */
export type Assignment = typeof AssignmentSchema.Type;
/** Public response returned only when an Assignment invocation is started by its assignee. */
export const AssignmentStartResponseSchema = Schema.Struct({
  ...AssignmentFields,
  capability: AssignmentInvocationCapabilitySchema,
});
/** Type representing assignment start response in the core domain. */
export type AssignmentStartResponse = typeof AssignmentStartResponseSchema.Type;
/** Protected persisted Assignment state, including active invocation verifiers. */
const PersistedAssignmentSchema = Schema.Struct({
  ...AssignmentFields,
  /** One-way verifier for newly issued active invocation capabilities. */
  active_invocation_capability_verifier: Schema.optional(AssignmentInvocationCapabilitySchema),
  /** Raw capability retained only when reading historical persisted records. */
  active_invocation_capability: Schema.optional(AssignmentInvocationCapabilitySchema),
});
type PersistedAssignment = typeof PersistedAssignmentSchema.Type;
const WORK_STATE_TRANSACTION_FILE = ".holycodex-transaction.toon";
const WORK_STATE_TRANSACTION_SCHEMA_VERSION = "holycodex-work-state-transaction-1" as const;
const WorkStateTransactionSchema = Schema.Struct({
  schema_version: Schema.Literals([WORK_STATE_TRANSACTION_SCHEMA_VERSION]),
  state: Schema.Literals(["prepared", "committed"]),
  files: Schema.Array(
    Schema.Struct({
      path: NonEmpty,
      previous: Schema.String,
      next: Schema.String,
    }),
  ).check(Schema.isMinLength(1)),
});
type WorkStateTransaction = typeof WorkStateTransactionSchema.Type;
const LegacyIntentSchema = Schema.Struct({
  schema_version: Schema.Literals(["holycodex-intent-0"]),
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
/** Type representing store error code in the core domain. */
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
  /** Machine-readable error classification. */
  readonly code: StoreErrorCode;
  /** Structured safe diagnostic context. */
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
  /** Filesystem root of the repository. */
  readonly root: string;
  /** Git common directory for the repository. */
  readonly gitCommonDir: string;
  /** Git commit checked for the captured baseline. */
  readonly head: string;
  /** Repository paths changed in the captured baseline. */
  readonly changedPaths: readonly string[];
  /** Digest of the captured repository status. */
  readonly statusDigest: string;
}
/** Dependency injection hooks for deterministic clocks and repository observation. */
export interface IntentStoreOptions {
  /** Timestamp used to establish the operation time. */
  readonly now?: () => Date;
  /** Repository baseline captured for the operation. */
  readonly repositorySnapshot?: () =>
    | Effect.Effect<RepositorySnapshot, unknown>
    | PromiseLike<RepositorySnapshot>;
}
/** User-owned data needed to create a durable Intent. */
export interface CreateIntentInput {
  /** Human-readable title for this record. */
  readonly title: string;
  /** User outcome tracked by this Intent. */
  readonly goal: string;
  /** Observable conditions required for acceptance. */
  readonly acceptanceCriteria: readonly string[];
  /** Whether creating this Intent requires an approved Plan first. */
  readonly planRequired?: boolean | undefined;
  /** Whether Root must record verification before completion. */
  readonly verificationRequired?: boolean | undefined;
  /** Whether Root must record review before completion. */
  readonly reviewRequired?: boolean | undefined;
}
/** Runtime schema for the input accepted by {@link IntentStore.createIntent}. */
export const CreateIntentInputSchema = Schema.Struct({
  title: NonEmpty,
  goal: NonEmpty,
  acceptanceCriteria: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
  planRequired: Schema.optional(Schema.Boolean),
  verificationRequired: Schema.optional(Schema.Boolean),
  reviewRequired: Schema.optional(Schema.Boolean),
});
/** Root-owned data used to create or revise the canonical Plan. */
export interface PlanInput {
  /** Chosen approach recorded in the plan. */
  readonly approach: string;
  /** Repository or task boundary covered by this record. */
  readonly scope?: readonly string[] | undefined;
  /** Work explicitly outside this record. */
  readonly exclusions?: readonly string[] | undefined;
  /** Assignments recorded on this plan input. */
  readonly assignments?: readonly string[] | undefined;
  /** Records or work that must precede this one. */
  readonly dependencies?: readonly string[] | undefined;
  /** Architecture constraints recorded in the plan. */
  readonly architecture?: readonly string[] | undefined;
  /** Known risks recorded in the plan. */
  readonly risks?: readonly string[] | undefined;
  /** Assumptions recorded in the plan. */
  readonly assumptions?: readonly string[] | undefined;
  /** Unresolved questions recorded in the plan. */
  readonly openQuestions?: readonly string[] | undefined;
  /** Verification required or completed for the plan. */
  readonly verification?: readonly string[] | undefined;
  /** Recovery procedure for the plan. */
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
  /** Stable identifier for this record. */
  readonly id?: string | undefined;
  /** Outcome this record is intended to achieve. */
  readonly objective: string;
  /** Role or authority responsible for this Assignment. */
  readonly owner: Assignment["owner"];
  /** Repository or task boundary covered by this record. */
  readonly scope: readonly string[];
  /** Requirements that constrain this record. */
  readonly constraints?: readonly string[] | undefined;
  /** Work explicitly outside this record. */
  readonly exclusions?: readonly string[] | undefined;
  /** Records or work that must precede this one. */
  readonly dependencies?: readonly string[] | undefined;
  /** Observable conditions required for acceptance. */
  readonly acceptanceCriteria: readonly string[];
}
/** Root-owned contract correction used to reconcile an honest Assignment scope. */
export interface ReviseAssignmentScopeInput {
  /** Repository or task boundary covered by this record. */
  readonly scope: readonly string[];
}
/** Optional Root-approved scope expansion applied while starting an Assignment. */
export interface AssignmentStartInput {
  /** Repository or task boundary covered by this record. */
  readonly scope?: readonly string[] | undefined;
}
/** Root-owned relation used to replace one unfinished Assignment with a validated sibling. */
export interface SupersedeAssignmentInput {
  /** Identifier of the record replacing this one. */
  readonly replacementId: string;
  /** Optional stale-write guard for the related replacement record. */
  readonly replacementRevision?: number | undefined;
  /** Reason for the recorded outcome. */
  readonly reason: string;
  /** Source and authority for this value. */
  readonly provenance: string;
}
/** Exact Root-owned VCS commit used to advance the repository baseline. */
export interface VcsIntegrationInput {
  /** Git commit associated with this outcome. */
  readonly commit: string;
}
/** Runtime schema for the input accepted by {@link IntentStore.createAssignment}. */
export const CreateAssignmentInputSchema = Schema.Struct({
  id: Schema.optional(NonEmpty),
  objective: NonEmpty,
  owner: AssignmentOwnerSchema,
  scope: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
  constraints: Schema.optional(Schema.Array(NonEmpty)),
  exclusions: Schema.optional(Schema.Array(NonEmpty)),
  dependencies: Schema.optional(Schema.Array(NonEmpty)),
  acceptanceCriteria: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
});
/** Runtime schema for the Root-owned Assignment scope reconciliation operation. */
export const ReviseAssignmentScopeInputSchema = Schema.Struct({
  scope: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
});
/** Runtime schema for bounded scope expansion at Assignment start. */
export const AssignmentStartInputSchema = Schema.Struct({
  scope: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
});
/** Runtime schema for explicit Assignment supersession. */
export const SupersedeAssignmentInputSchema = Schema.Struct({
  replacementId: Identifier,
  replacementRevision: Schema.optional(Revision),
  reason: NonEmpty,
  provenance: NonEmpty,
});
/** Runtime schema for exact commit integration at the Root-owned VCS boundary. */
export const VcsIntegrationInputSchema = Schema.Struct({
  commit: CommitSha,
});
/** Compact terminal outcome and evidence returned by one Assignment invocation. */
export interface AssignmentResultInput {
  /** Identifier of the invocation that produced this result. */
  readonly invocationId?: string | undefined;
  /** Capability issued when the active invocation was started. */
  readonly capability?: AssignmentInvocationCapability | undefined;
  /** Terminal outcome of this Assignment. */
  readonly outcome: AssignmentOutcome;
  /** Time at which the Assignment began. */
  readonly startedAt?: string | undefined;
  /** Concise result of the Assignment. */
  readonly summary: string;
  /** Optional Root-approved superset scope persisted with the terminal result. */
  readonly scope?: readonly string[] | undefined;
  /** Evidence supporting the reported result. */
  readonly evidence?: readonly IntentEvidence[] | undefined;
  /** Context7 evidence used to support the work. */
  readonly context7?: Context7Evidence | undefined;
  /** Exact condition preventing completion. */
  readonly blocker?: string | undefined;
  /** Risk that remains after the reported work. */
  readonly remainingRisk?: readonly string[] | undefined;
}
/** Runtime schema for the input accepted by {@link IntentStore.recordAssignmentResult}. */
export const AssignmentResultInputSchema = Schema.Struct({
  invocationId: Schema.optional(NonEmpty),
  capability: Schema.optional(AssignmentInvocationCapabilitySchema),
  outcome: AssignmentOutcomeSchema,
  startedAt: Schema.optional(NonEmpty),
  summary: NonEmpty,
  scope: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  evidence: Schema.optional(Schema.Array(EvidenceSchema)),
  context7: Schema.optional(Context7EvidenceSchema),
  blocker: Schema.optional(NonEmpty),
  remainingRisk: Schema.optional(Schema.Array(NonEmpty)),
});
const AssignmentInterruptionRecoveryInputSchema = Schema.Struct({
  invocationId: NonEmpty,
  startedAt: DateText,
  capability: AssignmentInvocationCapabilitySchema,
  interruptionReason: NonEmpty,
});
/** Machine-readable reasons a predicate-checked Intent completion was refused. */
export interface CompletionRefusal {
  /** Whether all required work is complete. */
  readonly completed: false;
  /** Reasons completion requirements remain unmet. */
  readonly reasons: readonly string[];
}
/** One deterministic, actionable finding from a read-only work-state diagnosis. */
export interface WorkStateDiagnosticIssue {
  /** Machine-readable error classification. */
  readonly code: string;
  /** Record affected by this issue. */
  readonly subject: string;
  /** Meaningful repair available for this issue. */
  readonly repair: string;
}
/** Read-only diagnosis of one Intent and its canonical Plan and Assignments. */
export interface WorkStateDiagnosis {
  /** Parent Intent owning this Assignment. */
  readonly intent_id: string;
  /** Concrete issues found during validation. */
  readonly issues: readonly WorkStateDiagnosticIssue[];
}
/** Root-owned evidence and gate updates accepted by the Intent store. */
export interface IntentEvidenceInput {
  /** Evidence supporting the reported result. */
  readonly evidence?: readonly IntentEvidence[] | undefined;
  /** Verification required or completed for the plan. */
  readonly verification?: "passed" | "failed" | undefined;
  /** Review result for the completed work. */
  readonly review?: "accepted" | "rejected" | undefined;
  /** Whether the Assignment acceptance criteria are met. */
  readonly acceptanceMet?: boolean | undefined;
  /** Whether evidence is ready for Root acceptance. */
  readonly rootReadiness?: boolean | undefined;
  /** Whether completion blockers have been cleared. */
  readonly clearBlockers?: boolean | undefined;
}
/** Runtime schema for Root-owned evidence and gate updates. */
export const IntentEvidenceInputSchema = Schema.Struct({
  evidence: Schema.optional(Schema.Array(EvidenceSchema)),
  verification: Schema.optional(Schema.Literals(["passed", "failed"])),
  review: Schema.optional(Schema.Literals(["accepted", "rejected"])),
  acceptanceMet: Schema.optional(Schema.Boolean),
  rootReadiness: Schema.optional(Schema.Boolean),
  clearBlockers: Schema.optional(Schema.Boolean),
});
const execFileAsync = promisify(execFile);
/** Official-TOON backed deterministic repository-local Intent persistence. */
export class IntentStore {
  /** Root directory of the managed repository. */
  readonly repositoryRoot: string;
  /** Directory holding persisted work state. */
  readonly stateRoot: string;
  readonly #now: () => Date;
  /** Inspects one Intent without recovery, migration, locking, or writes. */
  diagnose(reference: string): Effect.Effect<WorkStateDiagnosis, unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#ensureStateRoot();
      const entries = yield* promiseEffect(() => readdir(self.stateRoot)).pipe(
        Effect.catchIf(
          () => true,
          (error: unknown) =>
            Effect.gen(function* () {
              if (isFsCode(error, "ENOENT"))
                return yield* Effect.fail(
                  new IntentStoreError("not_found", "Intent was not found.", { reference }),
                );
              return yield* Effect.fail(storeIo(error));
            }),
        ),
      );
      const matches: {
        directory: string;
        intent: Intent;
      }[] = [];
      for (const entry of entries.sort()) {
        const directory = join(self.stateRoot, entry);
        if (!(yield* isDirectory(directory)) || !(yield* isFile(join(directory, "intent.toon"))))
          continue;
        let intent!: Intent;
        {
          const recovery1 = yield* Effect.gen(function* () {
            intent = yield* readIntentForDiagnosis(join(directory, "intent.toon"));
            return { kind: "none" } as const;
          })
            .pipe(Effect.catchDefect((error) => Effect.fail(error)))
            .pipe(
              Effect.catchIf(
                () => true,
                (error) =>
                  Effect.gen(function* () {
                    if (isDiagnosticRecordError(error)) {
                      if (
                        entry === reference ||
                        (error.code !== "not_found" &&
                          (yield* intentIdentityMatches(join(directory, "intent.toon"), reference)))
                      )
                        return yield* Effect.fail(error);
                      return { kind: "continue" } as const;
                    }
                    return yield* Effect.fail(error);
                    return { kind: "none" } as const;
                  }),
              ),
            );
          if (recovery1.kind === "continue") continue;
        }
        if ([intent.id, intent.slug, entry].includes(reference))
          matches.push({ directory, intent });
      }
      if (matches.length !== 1)
        return yield* Effect.fail(
          new IntentStoreError(
            matches.length ? "current_ambiguous" : "not_found",
            matches.length ? "Intent reference is ambiguous." : "Intent was not found.",
            { reference },
          ),
        );
      const { directory, intent } = matches[0]!;
      const issues: WorkStateDiagnosticIssue[] = [];
      const add = (code: string, subject: string, repair: string): void => {
        issues.push({ code, subject, repair });
      };
      const transactionPath = join(directory, WORK_STATE_TRANSACTION_FILE);
      {
        const recovery2 = yield* Effect.gen(function* () {
          const transaction = yield* promiseEffect(() => lstat(transactionPath));
          if (transaction.isSymbolicLink() || !transaction.isFile())
            add(
              "transaction_journal_invalid",
              "intent",
              "Restore the transaction journal as a regular repository-local file.",
            );
          else
            add(
              "pending_transaction",
              "intent",
              "Recover the interrupted work-state transaction before relying on this diagnosis.",
            );
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (!isFsCode(error, "ENOENT") && !isFsCode(error, "ENOTDIR"))
                    return yield* Effect.fail(storeIo(error));
                  return { kind: "none" } as const;
                }),
            ),
          );
      }
      const planPath = join(directory, "plan.toon");
      let plan!: IntentPlan | undefined;
      let planUnreadable = false;
      {
        const recovery3 = yield* Effect.gen(function* () {
          plan = yield* readOptionalValidatedToon(planPath, PlanSchema);
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (!isDiagnosticRecordError(error)) return yield* Effect.fail(error);
                  planUnreadable = true;
                  add(
                    "plan_unreadable",
                    "plan",
                    "Repair the canonical Plan record before continuing.",
                  );
                  return { kind: "none" } as const;
                }),
            ),
          );
      }
      if (plan !== undefined) {
        const digest = sha256(`${encodeToon(plan)}\n`);
        if (
          plan.intent_id !== intent.id ||
          intent.active_plan_revision !== plan.revision ||
          intent.active_plan_digest !== digest
        )
          add(
            "plan_provenance_mismatch",
            "plan",
            "Reconcile the canonical Plan and Intent provenance.",
          );
      } else if (
        !planUnreadable &&
        (intent.active_plan_revision !== undefined || intent.active_plan_digest !== undefined)
      ) {
        add("stale_plan_reference", "intent", "Restore or reconcile the referenced Plan.");
      }
      const assignmentRoot = join(directory, "assignments");
      let assignmentEntries: string[] = [];
      {
        const recovery4 = yield* Effect.gen(function* () {
          if (yield* assertDirectory(assignmentRoot, true))
            assignmentEntries = (yield* promiseEffect(() => readdir(assignmentRoot)))
              .filter((entry) => entry.endsWith(".toon"))
              .sort();
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (!isDiagnosticRecordError(error)) return yield* Effect.fail(error);
                  add(
                    "assignment_directory_invalid",
                    "assignments",
                    "Restore the Assignments directory as a real repository-local directory.",
                  );
                  return { kind: "none" } as const;
                }),
            ),
          );
      }
      const assignments: PersistedAssignment[] = [];
      for (const entry of assignmentEntries) {
        let assignment!: PersistedAssignment;
        {
          const recovery5 = yield* Effect.gen(function* () {
            assignment = yield* readValidatedToon(
              join(assignmentRoot, entry),
              PersistedAssignmentSchema,
            );
            return { kind: "none" } as const;
          })
            .pipe(Effect.catchDefect((error) => Effect.fail(error)))
            .pipe(
              Effect.catchIf(
                () => true,
                (error) =>
                  Effect.gen(function* () {
                    if (!isDiagnosticRecordError(error)) return yield* Effect.fail(error);
                    add(
                      "assignment_unreadable",
                      entry,
                      "Repair this Assignment record before continuing.",
                    );
                    return { kind: "continue" } as const;
                    return { kind: "none" } as const;
                  }),
              ),
            );
          if (recovery5.kind === "continue") continue;
        }
        if (assignment.intent_id !== intent.id || entry !== `${assignment.id}.toon`) {
          add("assignment_identity_mismatch", entry, "Reconcile the Assignment identity and path.");
          continue;
        }
        assignments.push(assignment);
      }
      const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
      for (const assignment of assignments) {
        const subject = `assignment:${assignment.id}`;
        const activeId = assignment.active_invocation_id;
        const active = activeId !== undefined;
        const hasActiveMetadata =
          active ||
          assignment.active_started_at !== undefined ||
          assignment.active_invocation_capability !== undefined ||
          assignment.active_invocation_capability_verifier !== undefined;
        if (assignment.status === "executing" && !active)
          add(
            "missing_active_invocation",
            subject,
            "Reconcile the executing Assignment's invocation.",
          );
        if (assignment.status !== "executing" && hasActiveMetadata)
          add(
            "orphaned_active_invocation",
            subject,
            "Reconcile the active invocation and Assignment status.",
          );
        if (active && assignment.active_started_at === undefined)
          add("missing_invocation_start", subject, "Reconcile the active invocation start time.");
        const invocationIds = new Set<string>();
        for (const invocation of assignment.invocations) {
          if (invocationIds.has(invocation.id))
            add("duplicate_invocation_id", subject, "Reconcile duplicate invocation records.");
          invocationIds.add(invocation.id);
        }
        if (activeId !== undefined && invocationIds.has(activeId))
          add("active_invocation_reused", subject, "Reconcile the active invocation identity.");
        if (assignment.status === "superseded" && assignment.superseded_by === undefined)
          add("missing_replacement", subject, "Record or reconcile the replacement Assignment.");
        if (assignment.superseded_by !== undefined) {
          const replacement = byId.get(assignment.superseded_by);
          if (
            assignment.superseded_by === assignment.id ||
            replacement?.supersedes !== assignment.id ||
            assignment.status !== "superseded"
          )
            add("stale_supersession", subject, "Reconcile both ends of the supersession relation.");
          else if (
            assignment.supersession_reason === undefined ||
            assignment.supersession_provenance === undefined ||
            replacement.supersession_reason === undefined ||
            replacement.supersession_provenance === undefined
          )
            add(
              "supersession_metadata_missing",
              subject,
              "Record the reason and provenance on both Assignments.",
            );
          else if (
            assignment.supersession_reason !== replacement.supersession_reason ||
            assignment.supersession_provenance !== replacement.supersession_provenance
          )
            add(
              "supersession_metadata_mismatch",
              subject,
              "Reconcile the reason and provenance on both Assignments.",
            );
        }
        if (
          assignment.supersedes !== undefined &&
          (assignment.supersedes === assignment.id ||
            byId.get(assignment.supersedes)?.superseded_by !== assignment.id)
        )
          add("stale_predecessor", subject, "Reconcile the predecessor Assignment reference.");
        for (const dependency of assignment.dependencies) {
          if (dependency === assignment.id)
            add("self_dependency", subject, "Remove the Assignment's dependency on itself.");
          else if (dependency.startsWith("assignment-") && !byId.has(dependency))
            add("stale_dependency", subject, `Reconcile missing dependency ${dependency}.`);
          else if (byId.get(dependency)?.status === "superseded")
            add(
              "superseded_dependency",
              subject,
              `Reconcile dependency ${dependency} with its replacement Assignment.`,
            );
        }
        const latestInvocation = assignment.invocations.at(-1);
        if (assignment.status === "completed") {
          if (
            latestInvocation?.outcome !== "completed" ||
            (latestInvocation.evidence.length === 0 && latestInvocation.context7 === undefined)
          )
            add(
              "completion_evidence_missing",
              subject,
              "Reconcile the completed invocation result and its evidence.",
            );
        } else if (
          ["blocked", "needs_root_input", "failed"].includes(assignment.status) &&
          latestInvocation?.outcome !== assignment.status
        ) {
          add(
            "assignment_result_mismatch",
            subject,
            "Reconcile the status with its latest result.",
          );
        }
        if (
          ["blocked", "needs_root_input"].includes(assignment.status) &&
          assignment.blocker === undefined
        )
          add("assignment_blocker_missing", subject, "Record the Assignment's current blocker.");
        if (assignment.status === "pending" && assignment.invocations.length > 0)
          add(
            "pending_assignment_has_history",
            subject,
            "Reconcile pending status with its results.",
          );
        if (!["completed", "superseded"].includes(assignment.status))
          add(
            "assignment_unresolved",
            subject,
            intent.state === "abandoned"
              ? "Treat as intentionally unfinished; create a new Intent if work resumes."
              : "Resume, repair, or explicitly supersede this Assignment.",
          );
      }
      if (plan !== undefined) {
        for (const reference of plan.assignments) {
          if (reference.startsWith("assignment-") && !byId.has(reference))
            add("stale_plan_assignment", "plan", `Reconcile missing Assignment ${reference}.`);
          else if (byId.get(reference)?.status === "superseded")
            add(
              "superseded_plan_assignment",
              "plan",
              `Reconcile Plan reference ${reference} with its replacement Assignment.`,
            );
        }
      }
      const cyclicDependencies = findAssignmentDependencyCycles(assignments);
      for (const assignmentId of cyclicDependencies)
        add(
          "dependency_cycle",
          `assignment:${assignmentId}`,
          "Remove the cyclic Assignment dependency before continuing.",
        );
      if (
        intent.state === "complete" &&
        assignments.some((assignment) => !["completed", "superseded"].includes(assignment.status))
      )
        add(
          "terminal_intent_with_unresolved_work",
          "intent",
          "Reconcile terminal state and unfinished Assignments.",
        );
      if (intent.state === "complete" && assignments.length === 0)
        add("assignment_required", "intent", "Reconcile the required Assignment record.");
      if (["complete", "abandoned"].includes(intent.state) && intent.blockers.length > 0)
        add("terminal_intent_with_blockers", "intent", "Reconcile terminal state and blockers.");
      if (["blocked", "needs_root_input"].includes(intent.state)) {
        if (intent.blockers.length === 0)
          add(
            "blocked_without_reason",
            "intent",
            "Record the blocker or resume the previous state.",
          );
        if (intent.resume_state === undefined)
          add(
            "resume_state_missing",
            "intent",
            "Record the state to resume after the blocker clears.",
          );
      } else if (intent.resume_state !== undefined) {
        add("stale_resume_state", "intent", "Clear the stale blocked-state resume target.");
      }
      if (intent.state === "complete") {
        if (
          intent.verification.required &&
          (intent.verification.status !== "passed" ||
            !hasMeaningfulVerificationEvidence(intent.verification.evidence))
        )
          add(
            "verification_evidence_missing",
            "intent",
            "Reconcile required verification evidence.",
          );
        if (
          intent.review.required &&
          (intent.review.status !== "accepted" || intent.review.evidence.length === 0)
        )
          add("review_evidence_missing", "intent", "Reconcile required review evidence.");
        if (!intent.acceptance_met || !intent.root_readiness || intent.evidence.length === 0)
          add(
            "completion_evidence_missing",
            "intent",
            "Reconcile acceptance and Root readiness evidence.",
          );
      }
      {
        const recovery6 = yield* Effect.gen(function* () {
          yield* self.#assertNoDrift(
            intent,
            assignments
              .filter((assignment) => assignment.status === "executing")
              .flatMap((assignment) => assignment.scope),
          );
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (!(error instanceof IntentStoreError) || error.code !== "repository_drift")
                    return yield* Effect.fail(error);
                  add(
                    "repository_drift",
                    "repository",
                    "Reconcile the recorded baseline with the current repository state.",
                  );
                  return { kind: "none" } as const;
                }),
            ),
          );
      }
      issues.sort(
        (left, right) =>
          compareText(left.subject, right.subject) ||
          compareText(left.code, right.code) ||
          compareText(left.repair, right.repair),
      );
      return { intent_id: intent.id, issues };
    });
  }
  readonly #snapshot: () => Effect.Effect<RepositorySnapshot, unknown>;
  constructor(repositoryRoot: string, options: IntentStoreOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.stateRoot = join(this.repositoryRoot, ".holycodex");
    this.#now = options.now ?? (() => new Date());
    const injectedSnapshot = options.repositorySnapshot;
    this.#snapshot =
      injectedSnapshot === undefined
        ? () => readRepositorySnapshotEffect(this.repositoryRoot)
        : () =>
            Effect.suspend(() => {
              const value = injectedSnapshot();
              return Effect.isEffect(value) ? value : promiseEffect(() => Promise.resolve(value));
            });
  }
  /** Removes interrupted temporary writes without altering canonical state. */
  recover(): Effect.Effect<readonly string[], unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#ensureStateRoot();
      if (!(yield* exists(self.stateRoot))) return [];
      return yield* withLock(join(self.stateRoot, ".intent-store"), () =>
        Effect.gen(function* () {
          const removed = yield* self.#recoverTemps(self.stateRoot);
          const recovered = yield* self.#recoverTransactions();
          return [...removed, ...recovered].sort();
        }),
      );
    });
  }
  #recoverTemps(directory: string, recursive = false): Effect.Effect<readonly string[], unknown> {
    const self = this;
    return Effect.gen(function* () {
      let entries!: string[];
      {
        const recovery7 = yield* Effect.gen(function* () {
          entries = recursive
            ? yield* promiseEffect(() => readdir(directory, { recursive: true }))
            : yield* promiseEffect(() => readdir(directory));
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (isFsCode(error, "ENOENT")) return { kind: "return", value: [] } as const;
                  return yield* Effect.fail(storeIo(error));
                  return { kind: "none" } as const;
                }),
            ),
          );
        if (recovery7.kind === "return") return recovery7.value;
      }
      const removed: string[] = [];
      for (const entry of entries) {
        const name = basename(entry);
        if (!name.startsWith(".holycodex-write-") || !name.endsWith(".tmp")) continue;
        const temporaryPath = join(directory, entry);
        yield* assertNoSymlinkAncestors(temporaryPath);
        yield* promiseEffect(() => rm(temporaryPath, { force: true }));
        // `fs.readdir({ recursive: true })` uses the host separator. Keep the
        // recovery contract stable across Windows and POSIX hosts while the
        // native path above remains suitable for filesystem I/O.
        removed.push(relative(self.stateRoot, temporaryPath).replaceAll("\\", "/"));
      }
      return removed.sort();
    });
  }
  #recoverTransactions(): Effect.Effect<readonly string[], unknown> {
    const self = this;
    return Effect.gen(function* () {
      let entries!: string[];
      {
        const recovery8 = yield* Effect.gen(function* () {
          entries = yield* promiseEffect(() => readdir(self.stateRoot));
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (isFsCode(error, "ENOENT")) return { kind: "return", value: [] } as const;
                  return yield* Effect.fail(storeIo(error));
                  return { kind: "none" } as const;
                }),
            ),
          );
        if (recovery8.kind === "return") return recovery8.value;
      }
      const recovered: string[] = [];
      for (const entry of entries) {
        if (entry === ".intent-store") continue;
        const transactionDirectory = join(self.stateRoot, entry);
        if (!(yield* isDirectory(transactionDirectory))) continue;
        yield* withLock(join(transactionDirectory, ".intent-store"), () =>
          Effect.gen(function* () {
            recovered.push(...(yield* self.#recoverIntentDirectory(transactionDirectory)));
          }),
        );
      }
      return recovered.sort();
    });
  }
  #recoverIntentDirectory(directory: string): Effect.Effect<readonly string[], unknown> {
    const self = this;
    return Effect.gen(function* () {
      const recovered: string[] = [];
      const transactionPath = join(directory, WORK_STATE_TRANSACTION_FILE);
      if (yield* self.#recoverIntentTransaction(directory))
        recovered.push(relative(self.stateRoot, transactionPath).replaceAll("\\", "/"));
      recovered.push(...(yield* self.#recoverTemps(directory, true)));
      return recovered;
    });
  }
  #recoverIntentTransaction(directory: string): Effect.Effect<boolean, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const path = join(directory, WORK_STATE_TRANSACTION_FILE);
      yield* assertNoSymlinkAncestors(path);
      let entry!: Awaited<ReturnType<typeof lstat>>;
      {
        const recovery9 = yield* Effect.gen(function* () {
          entry = yield* promiseEffect(() => lstat(path));
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (isFsCode(error, "ENOENT")) return { kind: "return", value: false } as const;
                  return yield* Effect.fail(storeIo(error));
                  return { kind: "none" } as const;
                }),
            ),
          );
        if (recovery9.kind === "return") return recovery9.value;
      }
      if (entry.isSymbolicLink() || !entry.isFile())
        return yield* Effect.fail(
          new IntentStoreError(
            "schema_invalid",
            "The work-state transaction journal must be a regular file.",
            { path },
          ),
        );
      const transaction = yield* readValidatedToon(path, WorkStateTransactionSchema);
      const intentFiles = transaction.files.filter(
        (file) => canonicalRepositoryPath(file.path) === "intent.toon",
      );
      const assignmentFiles = transaction.files.filter((file) => {
        const canonical = canonicalRepositoryPath(file.path);
        return (
          canonical !== undefined && /^assignments\/[a-z0-9][a-z0-9-]{0,95}\.toon$/u.test(canonical)
        );
      });
      if (
        transaction.files.length < 2 ||
        intentFiles.length !== 1 ||
        assignmentFiles.length < 1 ||
        intentFiles.length + assignmentFiles.length !== transaction.files.length
      )
        return yield* Effect.fail(
          new IntentStoreError(
            "schema_invalid",
            "The work-state transaction must pair one or more Assignments with their Intent.",
            { path },
          ),
        );
      const seen = new Set<string>();
      const recoveredFiles = transaction.files.map((file) => {
        const canonical = canonicalRepositoryPath(file.path);
        if (canonical === undefined)
          throw new IntentStoreError(
            "schema_invalid",
            "The work-state transaction contains an invalid target path.",
            { path, target: file.path },
          );
        const target = transactionTarget(directory, file.path);
        if (seen.has(target))
          throw new IntentStoreError(
            "schema_invalid",
            "The work-state transaction has duplicate targets.",
            {
              path,
              target: file.path,
            },
          );
        seen.add(target);
        const contents = transaction.state === "committed" ? file.next : file.previous;
        const record =
          canonical === "intent.toon"
            ? parseValidatedToonText(contents, IntentSchema, target)
            : parseValidatedToonText(contents, PersistedAssignmentSchema, target);
        return { canonical, target, contents, record };
      });
      const recoveredIntentId = (
        recoveredFiles.find((file) => file.canonical === "intent.toon")?.record as
          | Intent
          | undefined
      )?.id;
      if (recoveredIntentId === undefined)
        return yield* Effect.fail(
          new IntentStoreError("schema_invalid", "The work-state transaction has no Intent.", {
            path,
          }),
        );
      for (const file of recoveredFiles) {
        yield* assertNoSymlinkAncestors(file.target);
        if (file.canonical !== "intent.toon") {
          const assignmentId = file.canonical.slice("assignments/".length, -".toon".length);
          assertAssignmentIdentity(
            file.record as PersistedAssignment,
            recoveredIntentId,
            assignmentId,
            file.target,
          );
        }
      }
      for (const file of recoveredFiles) yield* atomicWriteText(file.target, file.contents);
      yield* promiseEffect(() => rm(path, { force: true }));
      yield* syncDirectory(directory);
      return true;
    });
  }
  #ensureStateRoot(): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.gen(function* () {
      {
        const recovery10 = yield* Effect.gen(function* () {
          const entry = yield* promiseEffect(() => lstat(self.stateRoot));
          if (entry.isSymbolicLink() || !entry.isDirectory())
            return yield* Effect.fail(
              new IntentStoreError(
                "schema_invalid",
                "Repository-local work state must be a real directory.",
                { path: self.stateRoot },
              ),
            );
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (isFsCode(error, "ENOENT"))
                    return { kind: "return", value: undefined } as const;
                  return yield* Effect.fail(storeIo(error));
                  return { kind: "none" } as const;
                }),
            ),
          );
        if (recovery10.kind === "return") return recovery10.value;
      }
    });
  }
  /** Creates a deterministic repository-local Intent and selects it as current. */
  createIntent(input: CreateIntentInput): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(CreateIntentInputSchema, input);
      if (
        !validated.title.trim() ||
        !validated.goal.trim() ||
        validated.acceptanceCriteria.length === 0
      )
        return yield* Effect.fail(
          invalidInput("Intent title, goal, and acceptance criteria are required."),
        );
      yield* self.recover();
      yield* promiseEffect(() => mkdir(self.stateRoot, { recursive: true }));
      return yield* withLock(join(self.stateRoot, ".intent-store"), () =>
        Effect.gen(function* () {
          const snapshot = yield* self.#snapshot();
          const slug = slugify(validated.title);
          const shortId = sha256(
            [snapshot.root, validated.title.trim(), validated.goal.trim()].join("\0"),
          ).slice(0, 10);
          let directoryName = `${slug}-${shortId}`;
          let collision = 1;
          while (yield* exists(join(self.stateRoot, directoryName))) {
            collision += 1;
            directoryName = `${slug}-${shortId}-${String(collision).padStart(2, "0")}`;
          }
          const id = `intent-${shortId}${collision === 1 ? "" : `-${String(collision).padStart(2, "0")}`}`;
          const timestamp = self.#now().toISOString();
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
          const directory = join(self.stateRoot, directoryName);
          yield* promiseEffect(() => mkdir(join(directory, "assignments"), { recursive: true }));
          yield* atomicWriteToon(join(directory, "intent.toon"), intent);
          yield* atomicWriteText(join(self.stateRoot, "current"), `${directoryName}\n`);
          return intent;
        }),
      );
    });
  }
  /** Lists every validated Intent in deterministic identifier order. */
  listIntents(): Effect.Effect<readonly Intent[], unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#ensureStateRoot();
      if (!(yield* exists(self.stateRoot))) return [];
      return yield* withLock(join(self.stateRoot, ".intent-store"), () =>
        Effect.gen(function* () {
          yield* self.#recoverTemps(self.stateRoot);
          let entries!: string[];
          {
            const recovery11 = yield* Effect.gen(function* () {
              entries = yield* promiseEffect(() => readdir(self.stateRoot));
              return { kind: "none" } as const;
            })
              .pipe(Effect.catchDefect((error) => Effect.fail(error)))
              .pipe(
                Effect.catchIf(
                  () => true,
                  (error) =>
                    Effect.gen(function* () {
                      if (isFsCode(error, "ENOENT")) return { kind: "return", value: [] } as const;
                      return yield* Effect.fail(storeIo(error));
                      return { kind: "none" } as const;
                    }),
                ),
              );
            if (recovery11.kind === "return") return recovery11.value;
          }
          const values: Intent[] = [];
          for (const entry of entries.sort()) {
            if (entry === ".intent-store") continue;
            const directory = join(self.stateRoot, entry);
            if (!(yield* isDirectory(directory))) continue;
            yield* withLock(join(directory, ".intent-store"), () =>
              Effect.gen(function* () {
                yield* self.#recoverIntentDirectory(directory);
                const path = join(directory, "intent.toon");
                if (yield* isFile(path)) values.push(yield* self.#readIntentPath(path));
              }),
            );
          }
          return values.sort((a, b) => a.id.localeCompare(b.id));
        }),
      );
    });
  }
  /** Reads one Intent by identifier, directory name, or unique slug. */
  readIntent(reference: string): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          return yield* self.#readIntentPath(join(directory, "intent.toon"));
        }),
      );
    });
  }
  /** Resolves the selected current Intent without guessing among multiple active Intents. */
  currentIntent(): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#ensureStateRoot();
      yield* self.recover();
      const pointer = join(self.stateRoot, "current");
      const pointerEntry = yield* promiseEffect(() => lstat(pointer)).pipe(
        Effect.catchIf(
          () => true,
          (error: unknown) =>
            Effect.gen(function* () {
              if (isFsCode(error, "ENOENT")) return undefined;
              return yield* Effect.fail(storeIo(error));
            }),
        ),
      );
      if (pointerEntry?.isSymbolicLink() || (pointerEntry && !pointerEntry.isFile()))
        return yield* Effect.fail(
          new IntentStoreError(
            "schema_invalid",
            "The current Intent pointer must be a regular file.",
          ),
        );
      const directory = pointerEntry
        ? (yield* promiseEffect(() => readFile(pointer, "utf8"))).trim()
        : "";
      if (pointerEntry && !directory)
        return yield* Effect.fail(
          new IntentStoreError(
            "schema_invalid",
            "The current Intent pointer must select a work-state directory.",
          ),
        );
      if (directory) {
        const selected = resolve(self.stateRoot, directory);
        if (!isWithin(self.stateRoot, selected))
          return yield* Effect.fail(
            new IntentStoreError(
              "schema_invalid",
              "The current Intent pointer escapes repository-local state.",
              { directory },
            ),
          );
        if (!(yield* isDirectory(selected)))
          return yield* Effect.fail(
            new IntentStoreError(
              "schema_invalid",
              "The current Intent pointer does not select a work-state directory.",
              { directory },
            ),
          );
        return yield* self.#withIntentLock(selected, () =>
          Effect.gen(function* () {
            return yield* self.#readIntentPath(join(selected, "intent.toon"));
          }),
        );
      }
      const active = (yield* self.listIntents()).filter(
        (value) => value.state !== "complete" && value.state !== "abandoned",
      );
      if (active.length === 1) return active[0]!;
      return yield* Effect.fail(
        new IntentStoreError(
          active.length ? "current_ambiguous" : "not_found",
          active.length
            ? "Multiple active Intents require explicit selection."
            : "No current Intent exists.",
          { intent_ids: active.map((value) => value.id) },
        ),
      );
    });
  }
  /** Selects an existing Intent as current. */
  selectCurrent(reference: string): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const directory = yield* self.#locate(reference);
      const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
      yield* withLock(join(self.stateRoot, ".intent-store"), () =>
        Effect.gen(function* () {
          return yield* atomicWriteText(
            join(self.stateRoot, "current"),
            `${basename(directory)}\n`,
          );
        }),
      );
      return intent;
    });
  }
  /** Applies a guarded lifecycle transition and returns the revised Intent. */
  transitionIntent(
    reference: string,
    target: IntentState,
    expectedRevision: number,
    blocker?: string,
  ): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validatedTarget = parseSchema(IntentStateSchema, target);
      const validatedBlocker = blocker === undefined ? undefined : parseSchema(NonEmpty, blocker);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
        return yield* Effect.fail(invalidInput("Intent revision must be a positive integer."));
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertRevision(intent.revision, expectedRevision);
          if (validatedTarget === "complete")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "Use the predicate-checked complete operation.",
              ),
            );
          if (validatedTarget === "abandoned")
            return yield* self.#abandonDirectory(directory, intent);
          return yield* self.#transition(directory, intent, validatedTarget, validatedBlocker);
        }),
      );
    });
  }
  /** Predicate-checks and completes an Intent, or returns machine-readable refusal reasons. */
  completeIntent(
    reference: string,
    expectedRevision: number,
  ): Effect.Effect<Intent | CompletionRefusal, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertRevision(intent.revision, expectedRevision);
          assertIntentMutable(intent);
          yield* self.#assertNoDrift(intent);
          if (intent.active_plan_revision !== undefined) yield* self.readPlan(reference);
          const assignments = yield* self.#listPersistedAssignments(directory, intent);
          const reasons: string[] = [];
          if (intent.state !== "reviewing") reasons.push("intent_not_reviewing");
          if (intent.blockers.length) reasons.push("global_blockers_unresolved");
          if (assignments.length === 0) reasons.push("assignment_required");
          if (
            assignments.some(
              (value) => value.status !== "completed" && value.status !== "superseded",
            )
          )
            reasons.push("assignments_unresolved");
          if (intent.verification.required && intent.verification.status !== "passed")
            reasons.push("verification_unresolved");
          if (intent.review.required && intent.review.status !== "accepted")
            reasons.push("review_unresolved");
          if (!intent.acceptance_met) reasons.push("acceptance_criteria_unmet");
          if (!intent.root_readiness) reasons.push("root_readiness_missing");
          if (reasons.length) return { completed: false, reasons };
          const completed = reviseIntent(intent, self.#now, { state: "complete" });
          yield* atomicWriteToon(join(directory, "intent.toon"), completed);
          return completed;
        }),
      );
    }) as Effect.Effect<Intent | CompletionRefusal, unknown>;
  }
  /** Closes incomplete work without representing it as completed. */
  abandonIntent(reference: string, expectedRevision: number): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertRevision(intent.revision, expectedRevision);
          return yield* self.#abandonDirectory(directory, intent);
        }),
      );
    });
  }
  /** Records global proof and gate state owned by Root. */
  recordIntentEvidence(
    reference: string,
    expectedRevision: number,
    input: IntentEvidenceInput,
  ): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(IntentEvidenceInputSchema, input);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertRevision(intent.revision, expectedRevision);
          assertIntentMutable(intent);
          if (validated.verification !== undefined || validated.review !== undefined)
            yield* self.#assertNoDrift(intent);
          if (validated.verification !== undefined && intent.state !== "verifying")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "Verification evidence is only accepted while the Intent is verifying.",
                { state: intent.state },
              ),
            );
          const verificationEvidence = [
            ...intent.verification.evidence,
            ...(validated.evidence ?? []),
          ];
          if (
            validated.verification === "passed" &&
            !hasMeaningfulVerificationEvidence(verificationEvidence)
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_input",
                "Verification cannot pass without meaningful successful check or behavioral evidence.",
                { required_evidence: ["check", "behavior", "ci"] },
              ),
            );
          if (validated.review !== undefined && intent.state !== "reviewing")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "Review evidence is only accepted while the Intent is reviewing.",
                { state: intent.state },
              ),
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
          const revised = reviseIntent(intent, self.#now, {
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
          yield* atomicWriteToon(join(directory, "intent.toon"), revised);
          return revised;
        }),
      );
    });
  }
  /** Records Root-owned integration of the exact reviewed change set into a commit. */
  recordVcsIntegration(
    reference: string,
    expectedRevision: number,
    input: VcsIntegrationInput,
  ): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(VcsIntegrationInputSchema, input);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertRevision(intent.revision, expectedRevision);
          assertIntentMutable(intent);
          if (intent.state !== "reviewing")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "VCS integration is only accepted after review while the Intent is reviewing.",
                { state: intent.state },
              ),
            );
          if (intent.review.required && intent.review.status !== "accepted")
            return yield* Effect.fail(
              new IntentStoreError(
                "not_ready",
                "VCS integration requires accepted review evidence.",
                { review_status: intent.review.status },
              ),
            );
          const snapshot = yield* self.#snapshot();
          if (
            snapshot.root !== intent.baseline.root ||
            snapshot.gitCommonDir !== intent.baseline.git_common_dir
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "repository_drift",
                "VCS integration repository identity does not match the Intent baseline.",
                { expected_root: intent.baseline.root, actual_root: snapshot.root },
              ),
            );
          if (snapshot.head !== validated.commit)
            return yield* Effect.fail(
              new IntentStoreError(
                "repository_drift",
                "VCS integration requires the requested commit to be the current HEAD.",
                { expected_head: validated.commit, actual_head: snapshot.head },
              ),
            );
          if (snapshot.changedPaths.length)
            return yield* Effect.fail(
              new IntentStoreError(
                "repository_drift",
                "VCS integration requires a clean worktree.",
                { changed_paths: [...snapshot.changedPaths].sort() },
              ),
            );
          const commit = yield* readExactCommit(self.repositoryRoot, validated.commit);
          if (commit.parents[0] !== intent.baseline.expected_head)
            return yield* Effect.fail(
              new IntentStoreError(
                "repository_drift",
                "VCS integration commit parent does not match the recorded baseline HEAD.",
                {
                  expected_parent: intent.baseline.expected_head,
                  actual_parents: commit.parents,
                },
              ),
            );
          const changedPaths = yield* readCommitChangedPaths(
            self.repositoryRoot,
            intent.baseline.expected_head,
            validated.commit,
          );
          const expectedPaths = [
            ...new Set(
              reconcilePersistedRepositoryPaths(intent.baseline.expected_changes, changedPaths),
            ),
          ].sort();
          if (changedPaths.join("\0") !== expectedPaths.join("\0"))
            return yield* Effect.fail(
              new IntentStoreError(
                "repository_drift",
                "VCS integration commit tree does not match the recorded expected change set.",
                { expected_changes: expectedPaths, actual_changes: changedPaths },
              ),
            );
          const timestamp = self.#now().toISOString();
          const evidence: IntentEvidence = {
            kind: "repository_fact",
            value: `Root VCS integration recorded at ${validated.commit}; ${String(changedPaths.length)} expected path(s) committed.`,
            result: "observed",
          };
          const revised = reviseIntent(intent, self.#now, {
            baseline: baselineFromSnapshot(
              snapshot,
              timestamp,
              intent.baseline.initial_head,
              validated.commit,
            ),
            evidence: [...intent.evidence, evidence],
          });
          yield* atomicWriteToon(join(directory, "intent.toon"), revised);
          return revised;
        }),
      );
    });
  }
  /** Reads the optional canonical Plan. */
  readPlan(reference: string): Effect.Effect<IntentPlan | undefined, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const directory = yield* self.#locate(reference);
      const path = join(directory, "plan.toon");
      if (!(yield* isFile(path))) return undefined;
      const plan = yield* readValidatedToon(path, PlanSchema);
      const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
      const digest = sha256(`${encodeToon(plan)}\n`);
      if (
        plan.intent_id !== intent.id ||
        intent.active_plan_revision !== plan.revision ||
        intent.active_plan_digest !== digest
      )
        return yield* Effect.fail(
          new IntentStoreError(
            "schema_invalid",
            "Canonical Plan provenance does not match its Intent.",
            {
              intent_id: intent.id,
              plan_revision: plan.revision,
            },
          ),
        );
      return plan;
    });
  }
  /** Replaces the canonical Plan while immutably archiving its predecessor. */
  revisePlan(
    reference: string,
    input: PlanInput,
    expectedIntentRevision: number,
    expectedPlanRevision?: number,
  ): Effect.Effect<
    {
      readonly intent: Intent;
      readonly plan: IntentPlan;
      readonly archived?: string;
    },
    unknown
  > {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(PlanInputSchema, input);
      if (!validated.approach.trim())
        return yield* Effect.fail(invalidInput("Plan approach is required."));
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertRevision(intent.revision, expectedIntentRevision);
          assertIntentMutable(intent);
          yield* self.#assertNoDrift(intent);
          const planPath = join(directory, "plan.toon");
          const current = (yield* isFile(planPath))
            ? yield* readValidatedToon(planPath, PlanSchema)
            : undefined;
          if (current === undefined && expectedPlanRevision !== undefined)
            assertRevision(0, expectedPlanRevision);
          if (current !== undefined) assertRevision(current.revision, expectedPlanRevision);
          let archived!: string | undefined;
          let predecessorDigest!: string | undefined;
          if (current) {
            const text = `${encodeToon(current)}\n`;
            predecessorDigest = sha256(text);
            archived = yield* nextArchivePath(directory);
            yield* immutableWrite(archived, text);
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
            updated_at: self.#now().toISOString(),
          });
          yield* atomicWriteToon(planPath, plan);
          const digest = sha256(`${encodeToon(plan)}\n`);
          const revisedIntent = reviseIntent(intent, self.#now, {
            active_plan_revision: plan.revision,
            active_plan_digest: digest,
            verification: resetGate(intent.verification),
            review: resetGate(intent.review),
            acceptance_met: false,
            root_readiness: false,
          });
          yield* atomicWriteToon(join(directory, "intent.toon"), revisedIntent);
          return {
            intent: revisedIntent,
            plan,
            ...(archived ? { archived: basename(archived) } : {}),
          };
        }),
      );
    });
  }
  /** Creates a bounded Assignment after validating the repository baseline. */
  createAssignment(
    reference: string,
    input: CreateAssignmentInput,
    expectedIntentRevision: number,
  ): Effect.Effect<Assignment, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(CreateAssignmentInputSchema, input);
      if (
        !validated.objective.trim() ||
        validated.scope.length === 0 ||
        validated.acceptanceCriteria.length === 0
      )
        return yield* Effect.fail(
          invalidInput("Assignment objective, scope, and acceptance criteria are required."),
        );
      const scope = canonicalScope(validated.scope);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertRevision(intent.revision, expectedIntentRevision);
          assertIntentMutable(intent);
          yield* self.#assertNoDrift(intent, scope);
          if (
            validated.owner.role === "Worker" &&
            validated.owner.task === "operations" &&
            intent.baseline.integrated_commit !== intent.baseline.expected_head
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "not_ready",
                "Worker.operations requires a successfully integrated exact commit.",
                { expected_head: intent.baseline.expected_head },
              ),
            );
          const id =
            validated.id ??
            `assignment-${sha256([intent.id, validated.objective, ...scope].join("\0")).slice(0, 10)}`;
          if (!/^[a-z0-9][a-z0-9-]{0,95}$/u.test(id))
            return yield* Effect.fail(invalidInput("Assignment id is invalid."));
          const path = join(directory, "assignments", `${id}.toon`);
          if (yield* exists(path))
            return yield* Effect.fail(
              new IntentStoreError("already_exists", "Assignment already exists.", { id }),
            );
          const timestamp = self.#now().toISOString();
          const assignment = parseSchema(AssignmentSchema, {
            schema_version: ASSIGNMENT_SCHEMA_VERSION,
            toon_compatibility: TOON_COMPATIBILITY,
            intent_id: intent.id,
            id,
            objective: validated.objective.trim(),
            owner: validated.owner,
            scope,
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
          yield* promiseEffect(() => mkdir(dirname(path), { recursive: true }));
          yield* atomicWriteToon(path, assignment);
          return assignment;
        }),
      );
    });
  }
  /** Reconciles an Assignment's bounded repository scope without changing its lifecycle. */
  reviseAssignmentScope(
    reference: string,
    assignmentId: string,
    input: ReviseAssignmentScopeInput,
    expectedRevision: number,
  ): Effect.Effect<Assignment, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(ReviseAssignmentScopeInputSchema, input);
      const scope = canonicalScope(validated.scope);
      const validatedId = parseSchema(Identifier, assignmentId);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertIntentMutable(intent);
          const assignment = yield* self.#readPersistedAssignment(directory, intent, validatedId);
          assertRevision(assignment.revision, expectedRevision);
          if (assignment.status === "completed" || assignment.status === "superseded")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "A completed or superseded Assignment cannot have its scope revised.",
              ),
            );
          const revised = reviseAssignment(assignment, self.#now, {
            scope,
          });
          yield* atomicWriteToon(join(directory, "assignments", `${validatedId}.toon`), revised);
          return projectAssignment(revised);
        }),
      );
    });
  }
  /**
   * Atomically replaces one unfinished Assignment with a related replacement.
   *
   * The relation is explicit and durable on both Assignment records. Completed, active, or already
   * superseded work cannot be hidden by this operation, and the replacement must belong to the same
   * Intent and overlap the predecessor's bounded repository scope.
   */
  supersedeAssignment(
    reference: string,
    assignmentId: string,
    expectedRevision: number,
    input: SupersedeAssignmentInput,
  ): Effect.Effect<
    {
      readonly assignment: Assignment;
      readonly replacement: Assignment;
      readonly intent: Intent;
    },
    unknown
  > {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(SupersedeAssignmentInputSchema, input);
      const validatedId = parseSchema(Identifier, assignmentId);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertIntentMutable(intent);
          if (intent.acceptance_met || intent.root_readiness || intent.review.status === "accepted")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "Accepted Intent evidence cannot be superseded.",
                { intent_id: intent.id },
              ),
            );
          const assignment = yield* self.#readPersistedAssignment(directory, intent, validatedId);
          assertRevision(assignment.revision, expectedRevision);
          const replacement = yield* self.#readPersistedAssignment(
            directory,
            intent,
            validated.replacementId,
          );
          if (validated.replacementRevision !== undefined)
            assertRevision(replacement.revision, validated.replacementRevision);
          if (replacement.id === assignment.id)
            return yield* Effect.fail(invalidInput("An Assignment cannot supersede itself."));
          if (assignment.status === "completed" || assignment.status === "superseded")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "Only unfinished, non-superseded Assignments may be replaced.",
                { assignment_id: assignment.id, status: assignment.status },
              ),
            );
          if (assignment.status === "executing")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "An executing Assignment must record its active invocation before supersession.",
                { assignment_id: assignment.id },
              ),
            );
          if (assignment.superseded_by !== undefined)
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "An Assignment with an existing replacement cannot be superseded again.",
                { assignment_id: assignment.id, replacement_id: assignment.superseded_by },
              ),
            );
          if (
            replacement.status === "completed" ||
            replacement.status === "executing" ||
            replacement.status === "superseded"
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "A supersession replacement must be unfinished and inactive.",
                { assignment_id: replacement.id, status: replacement.status },
              ),
            );
          if (replacement.supersedes !== undefined || replacement.superseded_by !== undefined)
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "An Assignment already participating in a supersession cannot be reused.",
                { assignment_id: replacement.id },
              ),
            );
          const overlappingScope = assignment.scope.some((scope) =>
            replacement.scope.some(
              (candidate) =>
                pathWithinAssignmentScope(scope, candidate) ||
                pathWithinAssignmentScope(candidate, scope),
            ),
          );
          if (!overlappingScope)
            return yield* Effect.fail(
              invalidInput(
                "A supersession replacement must overlap the predecessor bounded scope.",
              ),
            );
          const assignments = yield* self.#listPersistedAssignments(directory, intent);
          yield* self.#assertNoDrift(intent, [
            ...assignment.scope,
            ...replacement.scope,
            ...assignments
              .filter((candidate) => candidate.status === "executing")
              .flatMap((candidate) => candidate.scope),
          ]);
          const revisedAssignment = reviseAssignment(assignment, self.#now, {
            status: "superseded",
            blocker: undefined,
            active_invocation_id: undefined,
            active_started_at: undefined,
            active_invocation_capability_verifier: undefined,
            active_invocation_capability: undefined,
            superseded_by: replacement.id,
            supersession_reason: validated.reason.trim(),
            supersession_provenance: validated.provenance.trim(),
          });
          const revisedReplacement = reviseAssignment(replacement, self.#now, {
            supersedes: assignment.id,
            supersession_reason: validated.reason.trim(),
            supersession_provenance: validated.provenance.trim(),
          });
          const revisedIntent = reviseIntent(intent, self.#now, {
            state:
              intent.blockers.length === 0 &&
              ["blocked", "needs_root_input", "verifying", "reviewing"].includes(intent.state)
                ? "executing"
                : intent.state,
            blockers: [...intent.blockers],
            ...(intent.blockers.length === 0 ? { resume_state: undefined } : {}),
            verification: resetGate(intent.verification),
            review: resetGate(intent.review),
            acceptance_met: false,
            root_readiness: false,
            evidence: [
              ...intent.evidence,
              {
                kind: "behavior",
                value: `Assignment ${assignment.id} superseded by ${replacement.id}: ${validated.reason.trim()} (${validated.provenance.trim()})`,
                result: "observed",
              },
            ],
          });
          yield* self.#commitFiles(directory, [
            {
              path: `assignments/${assignment.id}.toon`,
              previous: `${encodeToon(assignment)}\n`,
              next: `${encodeToon(revisedAssignment)}\n`,
            },
            {
              path: `assignments/${replacement.id}.toon`,
              previous: `${encodeToon(replacement)}\n`,
              next: `${encodeToon(revisedReplacement)}\n`,
            },
            {
              path: "intent.toon",
              previous: `${encodeToon(intent)}\n`,
              next: `${encodeToon(revisedIntent)}\n`,
            },
          ]);
          return {
            assignment: projectAssignment(revisedAssignment),
            replacement: projectAssignment(revisedReplacement),
            intent: revisedIntent,
          };
        }),
      );
    });
  }
  /** Reads one Assignment. */
  readAssignment(reference: string, assignmentId: string): Effect.Effect<Assignment, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validatedId = parseSchema(Identifier, assignmentId);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          return projectAssignment(
            yield* self.#readPersistedAssignment(directory, intent, validatedId),
          );
        }),
      );
    });
  }
  /** Reports whether an executing Assignment needs the capability-free legacy recovery path. */
  isLegacyExecutingAssignment(
    reference: string,
    assignmentId: string,
  ): Effect.Effect<boolean, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validatedId = parseSchema(Identifier, assignmentId);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          const assignment = yield* self.#readPersistedAssignment(directory, intent, validatedId);
          return (
            assignment.status === "executing" &&
            assignment.active_invocation_capability_verifier === undefined &&
            assignment.active_invocation_capability === undefined
          );
        }),
      );
    });
  }
  #readPersistedAssignment(
    directory: string,
    intent: Intent,
    assignmentId: string,
  ): Effect.Effect<PersistedAssignment, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const assignmentsRoot = join(directory, "assignments");
      yield* assertDirectory(assignmentsRoot, true);
      const path = join(assignmentsRoot, `${assignmentId}.toon`);
      if (!(yield* isFile(path)))
        return yield* Effect.fail(
          new IntentStoreError("not_found", "Assignment was not found.", {
            assignment_id: assignmentId,
          }),
        );
      const assignment = yield* readValidatedToon(path, PersistedAssignmentSchema);
      assertAssignmentIdentity(assignment, intent.id, assignmentId, path);
      return assignment;
    });
  }
  /** Lists validated Assignments in deterministic identifier order. */
  listAssignments(reference: string): Effect.Effect<readonly Assignment[], unknown> {
    const self = this;
    return Effect.gen(function* () {
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          return (yield* self.#listPersistedAssignments(
            directory,
            yield* self.#readIntentPath(join(directory, "intent.toon")),
          )).map(projectAssignment);
        }),
      );
    });
  }
  #listPersistedAssignments(
    directory: string,
    intent: Intent,
  ): Effect.Effect<readonly PersistedAssignment[], unknown> {
    const self = this;
    return Effect.gen(function* () {
      const root = join(directory, "assignments");
      if (!(yield* assertDirectory(root, true))) return [];
      let entries!: string[];
      {
        const recovery12 = yield* Effect.gen(function* () {
          entries = yield* promiseEffect(() => readdir(root));
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (isFsCode(error, "ENOENT")) return { kind: "return", value: [] } as const;
                  return yield* Effect.fail(storeIo(error));
                  return { kind: "none" } as const;
                }),
            ),
          );
        if (recovery12.kind === "return") return recovery12.value;
      }
      const assignments = yield* Effect.all(
        entries
          .filter((entry) => entry.endsWith(".toon"))
          .sort()
          .map((entry) =>
            Effect.gen(function* () {
              const path = join(root, entry);
              const assignment = yield* readValidatedToon(path, PersistedAssignmentSchema);
              const expectedId = entry.slice(0, -".toon".length);
              assertAssignmentIdentity(assignment, intent.id, expectedId, path);
              return assignment;
            }),
          ),
      );
      return assignments;
    });
  }
  /** Starts or retries an Assignment invocation. */
  startAssignment(
    reference: string,
    assignmentId: string,
    expectedRevision: number,
    input: AssignmentStartInput = {},
  ): Effect.Effect<AssignmentStartResponse, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const validatedInput = parseSchema(AssignmentStartInputSchema, input);
      const validatedId = parseSchema(Identifier, assignmentId);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertIntentMutable(intent);
          const assignment = yield* self.#readPersistedAssignment(directory, intent, validatedId);
          assertRevision(assignment.revision, expectedRevision);
          if (
            !Result.isSuccess(Schema.decodeUnknownResult(AssignmentOwnerSchema)(assignment.owner))
          )
            return yield* Effect.fail(
              invalidInput("This Assignment owner is retired; supersede it with a current route."),
            );
          const scope = expandAssignmentScope(assignment.scope, validatedInput.scope);
          yield* self.#assertNoDrift(intent, scope);
          if (assignment.status === "completed")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "A completed Assignment cannot be restarted.",
              ),
            );
          if (assignment.status === "superseded")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "A superseded Assignment cannot be restarted.",
                { assignment_id: assignment.id },
              ),
            );
          if (assignment.status === "executing")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "Assignment is already executing; record its active invocation result first.",
                {
                  assignment_id: assignment.id,
                  ...(assignment.active_invocation_id
                    ? { invocation_id: assignment.active_invocation_id }
                    : {}),
                },
              ),
            );
          const startedAt = self.#now().toISOString();
          const invocationId = nextInvocationId(assignment);
          const capability = invocationCapability();
          const revised = reviseAssignment(assignment, self.#now, {
            status: "executing",
            scope,
            blocker: undefined,
            active_invocation_id: invocationId,
            active_started_at: startedAt,
            active_invocation_capability_verifier: sha256(capability),
            active_invocation_capability: undefined,
          });
          yield* atomicWriteToon(join(directory, "assignments", `${validatedId}.toon`), revised);
          return parseSchema(AssignmentStartResponseSchema, {
            ...projectAssignment(revised),
            capability,
          });
        }),
      );
    });
  }
  /** Appends one compact invocation result and its observable evidence. */
  recordAssignmentResult(
    reference: string,
    assignmentId: string,
    expectedRevision: number,
    input: AssignmentResultInput,
  ): Effect.Effect<
    {
      readonly assignment: Assignment;
      readonly intent: Intent;
    },
    unknown
  > {
    const self = this;
    return Effect.gen(function* () {
      return yield* self.#recordAssignmentResult(
        reference,
        assignmentId,
        expectedRevision,
        input,
        false,
      );
    });
  }
  /**
   * Persists a specialist result only when its active invocation capability is supplied. Newly
   * issued capabilities are checked against their verifier; historical raw capabilities remain
   * readable, and capability-free legacy records may use {@link IntentStore.recordAssignmentResult}.
   */
  recordSpecialistAssignmentResult(
    reference: string,
    assignmentId: string,
    expectedRevision: number,
    input: AssignmentResultInput,
  ): Effect.Effect<
    {
      readonly assignment: Assignment;
      readonly intent: Intent;
    },
    unknown
  > {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(AssignmentResultInputSchema, input);
      if (validated.capability === undefined)
        return yield* Effect.fail(
          invalidInput("Specialist Assignment results require an active invocation capability."),
        );
      return yield* self.#recordAssignmentResult(
        reference,
        assignmentId,
        expectedRevision,
        input,
        true,
      );
    });
  }
  /**
   * Records a confirmed stopped invocation as failed when its identity, start time, revision, and
   * Root-held capability match.
   */
  recoverInterruptedAssignment(
    reference: string,
    assignmentId: string,
    expectedRevision: number,
    input: {
      readonly invocationId: string;
      readonly startedAt: string;
      readonly capability: AssignmentInvocationCapability;
      readonly interruptionReason: string;
    },
  ): Effect.Effect<
    {
      readonly assignment: Assignment;
      readonly intent: Intent;
    },
    unknown
  > {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(AssignmentInterruptionRecoveryInputSchema, input);
      const reason = validated.interruptionReason.trim();
      const recoveryEvidence: IntentEvidence = {
        kind: "behavior",
        value: `Interrupted invocation ${validated.invocationId} started at ${validated.startedAt} recovered as failed: ${reason}`,
        result: "failed",
      };
      return yield* self.#recordAssignmentResult(
        reference,
        assignmentId,
        expectedRevision,
        {
          invocationId: validated.invocationId,
          capability: validated.capability,
          outcome: "failed",
          startedAt: validated.startedAt,
          summary: `Interrupted invocation recovered as failed: ${reason}`,
          evidence: [recoveryEvidence],
        },
        true,
        { invocationId: validated.invocationId, startedAt: validated.startedAt },
      );
    });
  }
  #recordAssignmentResult(
    reference: string,
    assignmentId: string,
    expectedRevision: number,
    input: AssignmentResultInput,
    requireCapability: boolean,
    recoveryMatch?: {
      readonly invocationId: string;
      readonly startedAt: string;
    },
  ): Effect.Effect<
    {
      readonly assignment: Assignment;
      readonly intent: Intent;
    },
    unknown
  > {
    const self = this;
    return Effect.gen(function* () {
      const validated = parseSchema(AssignmentResultInputSchema, input);
      const validatedId = parseSchema(Identifier, assignmentId);
      const directory = yield* self.#locate(reference);
      return yield* self.#withIntentLock(directory, () =>
        Effect.gen(function* () {
          const intent = yield* self.#readIntentPath(join(directory, "intent.toon"));
          assertIntentMutable(intent);
          if (recoveryMatch !== undefined && reference !== intent.id)
            return yield* Effect.fail(
              invalidInput("Interruption recovery requires the exact Intent ID reference."),
            );
          const assignment = yield* self.#readPersistedAssignment(directory, intent, validatedId);
          assertRevision(assignment.revision, expectedRevision);
          if (assignment.status !== "executing")
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                `Assignment result requires an executing Assignment; current status is ${assignment.status}.`,
                { assignment_id: assignment.id, status: assignment.status },
              ),
            );
          if (
            recoveryMatch === undefined &&
            !requireCapability &&
            validated.capability === undefined &&
            (assignment.active_invocation_capability_verifier !== undefined ||
              assignment.active_invocation_capability !== undefined)
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "This Assignment invocation requires its active capability to record a result.",
                { assignment_id: assignment.id },
              ),
            );
          if (recoveryMatch !== undefined) {
            if (
              assignment.active_invocation_id !== recoveryMatch.invocationId ||
              assignment.active_started_at !== recoveryMatch.startedAt
            )
              return yield* Effect.fail(
                new IntentStoreError(
                  "invalid_transition",
                  "Interruption recovery does not match the active invocation identity and start time.",
                  {
                    assignment_id: assignment.id,
                    expected_invocation_id: assignment.active_invocation_id,
                    expected_started_at: assignment.active_started_at,
                  },
                ),
              );
          }
          if (
            assignment.active_invocation_id !== undefined &&
            validated.invocationId !== undefined &&
            assignment.active_invocation_id !== validated.invocationId
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "Assignment result does not match the active invocation.",
                {
                  assignment_id: assignment.id,
                  expected_invocation_id: assignment.active_invocation_id,
                  actual_invocation_id: validated.invocationId,
                },
              ),
            );
          if (
            requireCapability &&
            (assignment.active_invocation_id === undefined || validated.invocationId === undefined)
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                recoveryMatch === undefined
                  ? "Specialist Assignment results require the active invocation identity."
                  : "Interruption recovery requires the active invocation identity.",
                { assignment_id: assignment.id },
              ),
            );
          if (
            requireCapability &&
            assignment.active_invocation_capability_verifier === undefined &&
            assignment.active_invocation_capability === undefined
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                recoveryMatch === undefined
                  ? "The active Assignment invocation has no capability to authorize a specialist result."
                  : "The active Assignment invocation has no capability to authorize interruption recovery.",
                { assignment_id: assignment.id },
              ),
            );
          if (
            validated.capability !== undefined &&
            (assignment.active_invocation_capability_verifier !== undefined
              ? sha256(validated.capability) !== assignment.active_invocation_capability_verifier
              : assignment.active_invocation_capability !== validated.capability)
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_transition",
                "Assignment result capability does not match the active invocation.",
                { assignment_id: assignment.id },
              ),
            );
          if (
            (validated.outcome === "blocked" || validated.outcome === "needs_root_input") &&
            !validated.blocker?.trim()
          )
            return yield* Effect.fail(invalidInput("Blocked results require a local blocker."));
          if (
            recoveryMatch === undefined &&
            context7RequiredForAssignment({
              role: assignment.owner.role,
              task: assignment.owner.task,
              objective: assignment.objective,
              scope: assignment.scope,
              constraints: assignment.constraints,
              exclusions: assignment.exclusions,
              dependencies: assignment.dependencies,
              acceptanceCriteria: assignment.acceptance_criteria,
            }) &&
            validated.context7 === undefined
          )
            return yield* Effect.fail(
              new IntentStoreError(
                "invalid_input",
                "This Librarian Assignment result requires typed Context7 evidence.",
                { assignment_id: assignment.id, required_evidence: "context7" },
              ),
            );
          const effectiveScope = expandAssignmentScope(assignment.scope, validated.scope);
          const snapshot = yield* self.#snapshot();
          const baselineExpectedChanges = reconcilePersistedRepositoryPaths(
            intent.baseline.expected_changes,
            snapshot.changedPaths,
          );
          const evidence = [...(validated.evidence ?? [])];
          const declared = new Set(
            evidence.filter((item) => item.kind === "changed_path").map((item) => item.value),
          );
          const outOfScope = [...declared].filter(
            (path) => !effectiveScope.some((scope) => pathWithinAssignmentScope(path, scope)),
          );
          if (outOfScope.length)
            return yield* Effect.fail(
              new IntentStoreError(
                "repository_drift",
                "Assignment evidence declares paths outside its bounded scope.",
                { assignment_id: assignment.id, out_of_scope_paths: outOfScope.sort() },
              ),
            );
          const assignments = yield* self.#listPersistedAssignments(directory, intent);
          const concurrent = assignments.filter(
            (value) => value.id !== assignment.id && value.status === "executing",
          );
          const concurrentPaths = snapshot.changedPaths.filter((path) =>
            concurrent.some((value) =>
              value.scope.some((scope) => pathWithinAssignmentScope(path, scope)),
            ),
          );
          const concurrentPathSet = new Set(concurrentPaths);
          const allowed = new Set([...baselineExpectedChanges, ...declared, ...concurrentPaths]);
          const unexpected = snapshot.changedPaths.filter((path) => !allowed.has(path));
          const baselineChanges = new Set(baselineExpectedChanges);
          const undeclaredCurrentScope = snapshot.changedPaths.filter(
            (path) =>
              effectiveScope.some((scope) => pathWithinAssignmentScope(path, scope)) &&
              !baselineChanges.has(path) &&
              !declared.has(path) &&
              !concurrentPathSet.has(path),
          );
          const identityChanged =
            snapshot.root !== intent.baseline.root ||
            snapshot.gitCommonDir !== intent.baseline.git_common_dir;
          const statusChanged =
            normalizeStatusDigest(snapshot.statusDigest) !== intent.baseline.expected_status_digest;
          const actualRelevantEvolution =
            snapshot.head !== intent.baseline.expected_head ||
            statusChanged ||
            [...new Set(baselineExpectedChanges)].sort().join("\0") !==
              [...new Set(snapshot.changedPaths)].sort().join("\0");
          const observedDeclaration = [...declared].some((path) =>
            snapshot.changedPaths.includes(path),
          );
          const observedConcurrentPath = concurrentPaths.length > 0;
          // Root-owned integration may advance HEAD before a result is recorded,
          // but only an explicitly declared Assignment evolution may explain it.
          if (
            recoveryMatch === undefined &&
            (identityChanged ||
              unexpected.length ||
              undeclaredCurrentScope.length ||
              (statusChanged && !observedDeclaration && !observedConcurrentPath) ||
              (snapshot.head !== intent.baseline.expected_head &&
                !observedDeclaration &&
                !observedConcurrentPath))
          ) {
            return yield* Effect.fail(
              new IntentStoreError(
                "repository_drift",
                "Repository state changed outside the recorded Assignment result.",
                {
                  expected_head: intent.baseline.expected_head,
                  actual_head: snapshot.head,
                  unexpected_paths: [...new Set([...unexpected, ...undeclaredCurrentScope])].sort(),
                  concurrent_assignments: concurrent.map((value) => value.id).sort(),
                },
              ),
            );
          }
          const timestamp = self.#now().toISOString();
          // Legacy executing records predate active invocation metadata. Preserve
          // their ability to finish while correlating all newly started work.
          const invocationId =
            assignment.active_invocation_id ??
            validated.invocationId ??
            nextInvocationId(assignment);
          if (assignment.invocations.some((value) => value.id === invocationId))
            return yield* Effect.fail(
              new IntentStoreError("already_exists", "Assignment invocation already exists.", {
                invocation_id: invocationId,
              }),
            );
          const invocation = parseSchema(InvocationSchema, {
            id: invocationId,
            outcome: validated.outcome,
            started_at: assignment.active_started_at ?? validated.startedAt ?? timestamp,
            finished_at: timestamp,
            summary: validated.summary,
            evidence,
            ...(validated.context7 === undefined ? {} : { context7: validated.context7 }),
            ...(validated.blocker ? { blocker: validated.blocker } : {}),
            remaining_risk: [...(validated.remainingRisk ?? [])],
          });
          const revised = reviseAssignment(assignment, self.#now, {
            status: validated.outcome,
            scope: effectiveScope,
            invocations: [...assignment.invocations, invocation],
            active_invocation_id: undefined,
            active_started_at: undefined,
            active_invocation_capability_verifier: undefined,
            active_invocation_capability: undefined,
            evidence: [...assignment.evidence, ...evidence],
            blocker: validated.blocker,
            remaining_risk: [...(validated.remainingRisk ?? [])],
          });
          const operations =
            assignment.owner.role === "Worker" && assignment.owner.task === "operations";
          const preserveIntegratedCommit =
            intent.baseline.integrated_commit !== undefined &&
            intent.baseline.integrated_commit === intent.baseline.expected_head &&
            snapshot.head === intent.baseline.expected_head &&
            snapshot.changedPaths.length === 0;
          const failedOperations = operations && validated.outcome === "failed";
          const successfulOperations =
            operations &&
            validated.outcome === "completed" &&
            preserveIntegratedCommit &&
            intent.state === "reviewing" &&
            (!intent.verification.required || intent.verification.status === "passed") &&
            (!intent.review.required || intent.review.status === "accepted");
          const invalidateGates = actualRelevantEvolution || validated.outcome === "failed";
          const revisedIntent = reviseIntent(intent, self.#now, {
            baseline:
              recoveryMatch === undefined
                ? baselineFromSnapshot(
                    snapshot,
                    timestamp,
                    intent.baseline.initial_head,
                    preserveIntegratedCommit ? intent.baseline.integrated_commit : undefined,
                  )
                : intent.baseline,
            ...(successfulOperations || !invalidateGates
              ? {}
              : {
                  state: failedOperations ? "executing" : intent.state,
                  verification: resetGate(intent.verification),
                  review: resetGate(intent.review),
                  acceptance_met: false,
                  root_readiness: false,
                }),
          });
          yield* self.#commitAssignmentAndIntent(
            directory,
            validatedId,
            assignment,
            revised,
            intent,
            revisedIntent,
          );
          return { assignment: projectAssignment(revised), intent: revisedIntent };
        }),
      );
    });
  }
  #transition(
    directory: string,
    intent: Intent,
    target: IntentState,
    blocker?: string,
  ): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const source = intent.state;
      if (target === "blocked" || target === "needs_root_input") {
        if (["complete", "abandoned", "blocked", "needs_root_input"].includes(source))
          return yield* Effect.fail(invalidTransition(source, target));
        if (!blocker?.trim())
          return yield* Effect.fail(invalidInput("A blocker or required input is required."));
        const revised = reviseIntent(intent, self.#now, {
          state: target,
          blockers: [blocker.trim()],
          resume_state: source as typeof ResumeStateSchema.Type,
        });
        yield* atomicWriteToon(join(directory, "intent.toon"), revised);
        return revised;
      }
      if (source === "blocked" || source === "needs_root_input") {
        if (target !== intent.resume_state || intent.blockers.length)
          return yield* Effect.fail(invalidTransition(source, target));
      } else {
        const allowed: Readonly<Record<string, readonly IntentState[]>> = {
          scoping: ["ready"],
          ready: ["executing"],
          executing: ["verifying"],
          verifying: ["reviewing", "executing"],
          reviewing: ["executing"],
        };
        if (!allowed[source]?.includes(target))
          return yield* Effect.fail(invalidTransition(source, target));
      }
      if (target === "ready") {
        const reasons: string[] = [];
        if (!intent.goal.trim()) reasons.push("goal_missing");
        if (!intent.acceptance_criteria.length) reasons.push("acceptance_criteria_missing");
        const plan =
          intent.active_plan_revision === undefined ? undefined : yield* self.readPlan(intent.id);
        if (plan?.open_questions.length) reasons.push("material_open_questions");
        if (reasons.length)
          return yield* Effect.fail(
            new IntentStoreError("not_ready", "Intent readiness predicates failed.", { reasons }),
          );
      }
      if (target === "executing" && source === "ready") yield* self.#assertNoDrift(intent);
      if (
        target === "reviewing" &&
        intent.verification.required &&
        intent.verification.status !== "passed"
      )
        return yield* Effect.fail(
          new IntentStoreError("invalid_transition", "Verification must pass before review."),
        );
      if (target === "reviewing") yield* self.#assertNoDrift(intent);
      const revised = reviseIntent(intent, self.#now, { state: target, resume_state: undefined });
      yield* atomicWriteToon(join(directory, "intent.toon"), revised);
      return revised;
    });
  }
  #withIntentLock<A>(
    directory: string,
    operation: () => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, unknown> {
    const self = this;
    return Effect.gen(function* () {
      return yield* withLock(join(directory, ".intent-store"), () =>
        Effect.gen(function* () {
          yield* self.#recoverIntentDirectory(directory);
          return yield* operation();
        }),
      );
    });
  }
  #commitAssignmentAndIntent(
    directory: string,
    assignmentId: string,
    previousAssignment: PersistedAssignment,
    nextAssignment: PersistedAssignment,
    previousIntent: Intent,
    nextIntent: Intent,
  ): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#commitFiles(directory, [
        {
          path: `assignments/${assignmentId}.toon`,
          previous: `${encodeToon(previousAssignment)}\n`,
          next: `${encodeToon(nextAssignment)}\n`,
        },
        {
          path: "intent.toon",
          previous: `${encodeToon(previousIntent)}\n`,
          next: `${encodeToon(nextIntent)}\n`,
        },
      ]);
    });
  }
  #commitFiles(
    directory: string,
    files: readonly {
      readonly path: string;
      readonly previous: string;
      readonly next: string;
    }[],
  ): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const transactionPath = join(directory, WORK_STATE_TRANSACTION_FILE);
      const transaction: WorkStateTransaction = parseSchema(WorkStateTransactionSchema, {
        schema_version: WORK_STATE_TRANSACTION_SCHEMA_VERSION,
        state: "prepared",
        files: files.map((file) => ({ ...file })),
      });
      const targets = transaction.files.map((file) => transactionTarget(directory, file.path));
      yield* atomicWriteToon(transactionPath, transaction);
      {
        const recovery14 = yield* Effect.gen(function* () {
          for (const [index, target] of targets.entries())
            yield* atomicWriteText(target, transaction.files[index]!.next);
          yield* atomicWriteToon(transactionPath, { ...transaction, state: "committed" });
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  {
                    const recovery13 = yield* Effect.gen(function* () {
                      yield* self.#recoverIntentTransaction(directory);
                      return { kind: "none" } as const;
                    })
                      .pipe(Effect.catchDefect((error) => Effect.fail(error)))
                      .pipe(
                        Effect.catchIf(
                          () => true,
                          (recoveryError) =>
                            Effect.gen(function* () {
                              return yield* Effect.fail(storeIo(recoveryError));
                              return { kind: "none" } as const;
                            }),
                        ),
                      );
                  }
                  return yield* Effect.fail(error);
                  return { kind: "none" } as const;
                }),
            ),
          );
      }
      yield* promiseEffect(() => rm(transactionPath, { force: true }));
      yield* syncDirectory(directory);
    });
  }
  #abandonDirectory(directory: string, intent: Intent): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      if (intent.state === "complete" || intent.state === "abandoned")
        return yield* Effect.fail(invalidTransition(intent.state, "abandoned"));
      const abandoned = reviseIntent(intent, self.#now, { state: "abandoned", blockers: [] });
      yield* atomicWriteToon(join(directory, "intent.toon"), abandoned);
      return abandoned;
    });
  }
  #assertNoDrift(intent: Intent, allowedScope?: readonly string[]): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const snapshot = yield* self.#snapshot();
      const expected = [
        ...reconcilePersistedRepositoryPaths(
          intent.baseline.expected_changes,
          snapshot.changedPaths,
        ),
      ].sort();
      const actual = [...snapshot.changedPaths].sort();
      const allowed = new Set(
        allowedScope === undefined
          ? []
          : actual.filter((path) =>
              allowedScope.some((scope) => pathWithinAssignmentScope(path, scope)),
            ),
      );
      const expectedWithAllowed = [...new Set([...expected, ...allowed])].sort();
      if (
        snapshot.root !== intent.baseline.root ||
        snapshot.gitCommonDir !== intent.baseline.git_common_dir ||
        snapshot.head !== intent.baseline.expected_head ||
        expectedWithAllowed.join("\0") !== actual.join("\0") ||
        (normalizeStatusDigest(snapshot.statusDigest) !== intent.baseline.expected_status_digest &&
          allowed.size === 0)
      ) {
        return yield* Effect.fail(
          new IntentStoreError(
            "repository_drift",
            "Repository baseline no longer matches recorded assumptions.",
            {
              expected_head: intent.baseline.expected_head,
              actual_head: snapshot.head,
              expected_changes: expectedWithAllowed,
              actual_changes: actual,
            },
          ),
        );
      }
    });
  }
  #locate(reference: string): Effect.Effect<string, unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#ensureStateRoot();
      let entries!: string[];
      {
        const recovery15 = yield* Effect.gen(function* () {
          entries = yield* promiseEffect(() => readdir(self.stateRoot));
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (isFsCode(error, "ENOENT"))
                    return yield* Effect.fail(
                      new IntentStoreError("not_found", "Intent was not found.", { reference }),
                    );
                  return yield* Effect.fail(storeIo(error));
                  return { kind: "none" } as const;
                }),
            ),
          );
      }
      const matches: string[] = [];
      for (const entry of entries.sort()) {
        const directory = join(self.stateRoot, entry);
        if (!(yield* isDirectory(directory))) continue;
        const path = join(directory, "intent.toon");
        if (!(yield* isFile(path))) continue;
        const intent = yield* self.#readIntentPath(path);
        if (intent.id === reference || intent.slug === reference || entry === reference)
          matches.push(directory);
      }
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1)
        return yield* Effect.fail(
          new IntentStoreError("current_ambiguous", "Intent reference is ambiguous.", {
            reference,
          }),
        );
      return yield* Effect.fail(
        new IntentStoreError("not_found", "Intent was not found.", { reference }),
      );
    });
  }
  #readIntentPath(path: string): Effect.Effect<Intent, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const decoded = yield* readRawToon(path);
      const current = decodeUnknown(IntentSchema, decoded);
      if (Result.isSuccess(current)) return current.success;
      const legacy = decodeUnknown(LegacyIntentSchema, decoded);
      if (Result.isFailure(legacy))
        return yield* Effect.fail(
          new IntentStoreError("schema_invalid", "Persisted Intent failed schema validation.", {
            path,
            error: String(current.failure),
          }),
        );
      const migrated = migrateLegacyIntent(legacy.success);
      yield* atomicWriteToon(path, migrated);
      return migrated;
    });
  }
}
/** Captures stable repository identity and current working state. */
export function readRepositorySnapshotEffect(
  repositoryRoot: string,
): Effect.Effect<RepositorySnapshot, unknown> {
  return Effect.gen(function* () {
    const root = yield* promiseEffect(() => realpath(repositoryRoot));
    const runGit = (...args: string[]): Effect.Effect<string, unknown> =>
      Effect.gen(function* () {
        {
          const recovery16 = yield* Effect.gen(function* () {
            return {
              kind: "return",
              value: (yield* promiseEffect(() =>
                execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" }),
              )).stdout.trimEnd(),
            } as const;
            return { kind: "none" } as const;
          })
            .pipe(Effect.catchDefect((error) => Effect.fail(error)))
            .pipe(
              Effect.catchIf(
                () => true,
                (error) =>
                  Effect.gen(function* () {
                    return yield* Effect.fail(
                      new IntentStoreError(
                        "io_failure",
                        "Repository identity requires an accessible Git worktree.",
                        { message: error instanceof Error ? error.message : String(error) },
                      ),
                    );
                    return { kind: "none" } as const;
                  }),
              ),
            );
          if (recovery16.kind === "return") return recovery16.value;
        }
      }) as Effect.Effect<string, unknown>;
    const common = yield* runGit("rev-parse", "--git-common-dir");
    const head = (yield* runGitOptional(root, "rev-parse", "--verify", "HEAD")) ?? "unborn";
    const status = yield* runGit("status", "--porcelain=v1", "-z", "--untracked-files=all");
    const legacyStatus = yield* runGit("status", "--porcelain=v1", "--untracked-files=all");
    const records = status.split("\0");
    const changedPaths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (!record) continue;
      changedPaths.push(record.slice(3));
      if (record.slice(0, 2).includes("R") || record.slice(0, 2).includes("C")) index += 1;
    }
    changedPaths.sort();
    return {
      root,
      gitCommonDir: resolve(root, common),
      head,
      changedPaths,
      statusDigest: sha256(legacyStatus),
    };
  });
}

/** Promise compatibility adapter for callers at the repository boundary. */
export function readRepositorySnapshot(repositoryRoot: string): Promise<RepositorySnapshot> {
  return Effect.runPromise(readRepositorySnapshotEffect(repositoryRoot));
}
interface ExactCommit {
  readonly hash: string;
  readonly parents: readonly string[];
}
function readExactCommit(
  repositoryRoot: string,
  commit: string,
): Effect.Effect<ExactCommit, unknown> {
  return Effect.gen(function* () {
    {
      const recovery17 = yield* Effect.gen(function* () {
        const output = (yield* promiseEffect(() =>
          execFileAsync("git", ["-C", repositoryRoot, "show", "-s", "--format=%H%n%P", commit], {
            encoding: "utf8",
          }),
        )).stdout.trim();
        const [hash, parents = ""] = output.split("\n");
        if (hash !== commit)
          return yield* Effect.fail(
            new Error(`Resolved commit ${hash ?? ""} does not match requested ${commit}.`),
          );
        return {
          kind: "return",
          value: { hash, parents: parents ? parents.split(/\s+/u) : [] },
        } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                return yield* Effect.fail(
                  new IntentStoreError(
                    "repository_drift",
                    "VCS integration commit could not be inspected.",
                    { commit, message: error instanceof Error ? error.message : String(error) },
                  ),
                );
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery17.kind === "return") return recovery17.value;
    }
  }) as Effect.Effect<ExactCommit, unknown>;
}
function readCommitChangedPaths(
  repositoryRoot: string,
  parent: string,
  commit: string,
): Effect.Effect<readonly string[], unknown> {
  return Effect.gen(function* () {
    {
      const recovery18 = yield* Effect.gen(function* () {
        const output = (yield* promiseEffect(() =>
          execFileAsync(
            "git",
            ["-C", repositoryRoot, "diff", "--name-only", "-z", "--no-ext-diff", parent, commit],
            { encoding: "utf8" },
          ),
        )).stdout;
        return { kind: "return", value: output.split("\0").filter(Boolean).sort() } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                return yield* Effect.fail(
                  new IntentStoreError(
                    "repository_drift",
                    "VCS integration commit tree could not be inspected.",
                    {
                      parent,
                      commit,
                      message: error instanceof Error ? error.message : String(error),
                    },
                  ),
                );
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery18.kind === "return") return recovery18.value;
    }
  }) as Effect.Effect<readonly string[], unknown>;
}
function runGitOptional(
  root: string,
  ...args: string[]
): Effect.Effect<string | undefined, unknown> {
  return Effect.gen(function* () {
    {
      const recovery19 = yield* Effect.gen(function* () {
        return {
          kind: "return",
          value: (yield* promiseEffect(() =>
            execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" }),
          )).stdout.trim(),
        } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (ignoredError) =>
              Effect.gen(function* () {
                return { kind: "return", value: undefined } as const;
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery19.kind === "return") return recovery19.value;
    }
  });
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
  integratedCommit?: string,
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
    ...(integratedCommit === undefined ? {} : { integrated_commit: integratedCommit }),
    updated_at: timestamp,
  };
}
function normalizeStatusDigest(value: string): string {
  return /^[a-f0-9]{64}$/u.test(value) ? value : sha256(value);
}
function hasMeaningfulVerificationEvidence(evidence: readonly IntentEvidence[]): boolean {
  return evidence.some(
    (item) =>
      ["check", "behavior", "ci"].includes(item.kind) &&
      ["passed", "observed"].includes(item.result ?? ""),
  );
}
function invocationCapability(): AssignmentInvocationCapability {
  return randomBytes(32).toString("hex");
}
function nextInvocationId(assignment: Assignment): string {
  let sequence = assignment.invocations.length + 1;
  let id = `invocation-${String(sequence).padStart(3, "0")}`;
  while (assignment.invocations.some((value) => value.id === id)) {
    sequence += 1;
    id = `invocation-${String(sequence).padStart(3, "0")}`;
  }
  return id;
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
  value: PersistedAssignment,
  now: () => Date,
  patch: Partial<PersistedAssignment>,
): PersistedAssignment {
  return parseSchema(
    PersistedAssignmentSchema,
    cleanUndefined({
      ...value,
      ...patch,
      revision: value.revision + 1,
      updated_at: now().toISOString(),
    }),
  );
}
function projectAssignment(value: PersistedAssignment): Assignment {
  const {
    active_invocation_capability_verifier: _verifier,
    active_invocation_capability: _capability,
    ...projection
  } = value;
  return parseSchema(AssignmentSchema, projection);
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
function canonicalScope(values: readonly string[]): readonly string[] {
  const canonical = values.map((value) => {
    const path = canonicalRepositoryPath(value);
    if (path === undefined)
      throw invalidInput("Assignment scope must contain canonical repository-relative paths.");
    return path;
  });
  return [...new Set(canonical)].sort();
}
function expandAssignmentScope(
  current: readonly string[],
  requested: readonly string[] | undefined,
): readonly string[] {
  const existing = canonicalScope(current);
  if (requested === undefined) return existing;
  const expanded = canonicalScope(requested);
  if (existing.some((path) => !expanded.includes(path)))
    throw invalidInput("Assignment scope expansion must preserve the existing scope.");
  const unauthorized = expanded.filter(
    (candidate) => !existing.some((scope) => assignmentScopeAuthorityContains(candidate, scope)),
  );
  if (unauthorized.length)
    throw invalidInput("Assignment scope expansion exceeds the declared component authority.");
  return expanded;
}
function assignmentScopeAuthorityContains(candidate: string, declaredScope: string): boolean {
  if (pathWithinAssignmentScope(candidate, declaredScope)) return true;
  const normalizedScope = canonicalRepositoryPath(declaredScope);
  if (normalizedScope === undefined || normalizedScope === ".") return false;
  const segments = normalizedScope.split("/");
  const leaf = segments.at(-1);
  if (leaf === undefined || !leaf.includes(".")) return false;
  const parent = segments.slice(0, -1).join("/") || ".";
  return candidate !== parent && pathWithinAssignmentScope(candidate, parent);
}
function pathWithinAssignmentScope(path: string, scope: string): boolean {
  const normalizedPath = canonicalRepositoryPath(path);
  const normalizedScope = canonicalRepositoryPath(scope);
  if (normalizedPath === undefined || normalizedScope === undefined) return false;
  return (
    normalizedScope === "." ||
    normalizedPath === normalizedScope ||
    normalizedPath.startsWith(`${normalizedScope}/`)
  );
}
function canonicalRepositoryPath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return undefined;
  const meaningful = segments.filter((segment) => segment !== "" && segment !== ".");
  return meaningful.length === 0 ? "." : meaningful.join("/");
}
function transactionTarget(directory: string, path: string): string {
  const canonical = canonicalRepositoryPath(path);
  if (
    canonical === undefined ||
    (canonical !== "intent.toon" &&
      !/^assignments\/[a-z0-9][a-z0-9-]{0,95}\.toon$/u.test(canonical))
  )
    throw new IntentStoreError(
      "schema_invalid",
      "The work-state transaction target is outside the supported Intent records.",
      { path },
    );
  const target = resolve(directory, canonical);
  if (!isWithin(resolve(directory), target))
    throw new IntentStoreError(
      "schema_invalid",
      "The work-state transaction target escapes the Intent directory.",
      { path },
    );
  return target;
}
function reconcilePersistedRepositoryPaths(
  persisted: readonly string[],
  actual: readonly string[],
): readonly string[] {
  const actualPaths = new Set(actual);
  return persisted.map((path) => {
    if (actualPaths.has(path)) return path;
    const decoded = decodeGitCQuotedPath(path);
    return decoded !== undefined && actualPaths.has(decoded) ? decoded : path;
  });
}
const GIT_C_QUOTED_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  "\\": 0x5c,
  '"': 0x22,
};
function decodeGitCQuotedPath(value: string): string | undefined {
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return undefined;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length;) {
    const codePoint = body.codePointAt(index);
    if (codePoint === undefined) return undefined;
    if (codePoint !== 0x5c) {
      if (codePoint === 0x22 || codePoint < 0x20 || codePoint === 0x7f) return undefined;
      const character = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(character));
      index += character.length;
      continue;
    }
    const escape = body[index + 1];
    if (escape === undefined) return undefined;
    const escaped = GIT_C_QUOTED_ESCAPES[escape];
    if (escaped !== undefined) {
      bytes.push(escaped);
      index += 2;
      continue;
    }
    if (escape < "0" || escape > "7") return undefined;
    let end = index + 2;
    while (end < body.length && end < index + 4 && body[end]! >= "0" && body[end]! <= "7") end += 1;
    bytes.push(Number.parseInt(body.slice(index + 1, end), 8));
    index = end;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return undefined;
  }
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
function parseSchema<A, I>(schema: Schema.Codec<A, I>, value: unknown): A {
  const decoded = decodeUnknown(schema, value);
  if (Result.isFailure(decoded))
    throw new IntentStoreError("schema_invalid", "Value failed Effect Schema validation.", {
      error: String(decoded.failure),
    });
  return decoded.success;
}
function readRawToon(path: string): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    let text!: string;
    {
      const recovery20 = yield* Effect.gen(function* () {
        const entry = yield* promiseEffect(() => lstat(path));
        if (entry.isSymbolicLink() || !entry.isFile())
          return yield* Effect.fail(
            new IntentStoreError(
              "schema_invalid",
              "Persistent work state must be a regular file.",
              { path },
            ),
          );
        text = yield* promiseEffect(() => readFile(path, "utf8"));
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isFsCode(error, "ENOENT"))
                  return yield* Effect.fail(
                    new IntentStoreError("not_found", "Persistent work state was not found.", {
                      path,
                    }),
                  );
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
    }
    return decodeToonText(text, path);
  });
}
function readValidatedToon<A, I>(
  path: string,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, unknown> {
  return Effect.gen(function* () {
    return parseSchema(schema, yield* readRawToon(path));
  });
}
function readOptionalValidatedToon<A, I>(
  path: string,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A | undefined, unknown> {
  return Effect.gen(function* () {
    let entry!: Awaited<ReturnType<typeof lstat>>;
    {
      const recovery21 = yield* Effect.gen(function* () {
        entry = yield* promiseEffect(() => lstat(path));
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isFsCode(error, "ENOENT") || isFsCode(error, "ENOTDIR"))
                  return { kind: "return", value: undefined } as const;
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery21.kind === "return") return recovery21.value;
    }
    if (entry.isSymbolicLink() || !entry.isFile())
      return yield* Effect.fail(
        new IntentStoreError("schema_invalid", "Persistent work state must be a regular file.", {
          path,
        }),
      );
    return yield* readValidatedToon(path, schema);
  }) as Effect.Effect<A | undefined, unknown>;
}
function readIntentForDiagnosis(path: string): Effect.Effect<Intent, unknown> {
  return Effect.gen(function* () {
    const value = yield* readRawToon(path);
    const current = decodeUnknown(IntentSchema, value);
    if (Result.isSuccess(current)) return current.success;
    const legacy = decodeUnknown(LegacyIntentSchema, value);
    if (Result.isFailure(legacy))
      return yield* Effect.fail(
        new IntentStoreError("schema_invalid", "Persisted Intent failed schema validation.", {
          path,
          error: String(current.failure),
        }),
      );
    return migrateLegacyIntent(legacy.success);
  });
}
function intentIdentityMatches(path: string, reference: string): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    let value!: unknown;
    {
      const recovery22 = yield* Effect.gen(function* () {
        value = yield* readRawToon(path);
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isDiagnosticRecordError(error))
                  return { kind: "return", value: false } as const;
                return yield* Effect.fail(error);
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery22.kind === "return") return recovery22.value;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const identity = value as {
      readonly id?: unknown;
      readonly slug?: unknown;
    };
    return identity.id === reference || identity.slug === reference;
  });
}
function isDiagnosticRecordError(error: unknown): error is IntentStoreError {
  return (
    error instanceof IntentStoreError &&
    ["malformed_toon", "schema_invalid", "not_found"].includes(error.code)
  );
}
function findAssignmentDependencyCycles(assignments: readonly PersistedAssignment[]): string[] {
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const visited = new Set<string>();
  const active: string[] = [];
  const cyclic = new Set<string>();
  const visit = (id: string): void => {
    const cycleStart = active.indexOf(id);
    if (cycleStart >= 0) {
      for (const member of active.slice(cycleStart)) cyclic.add(member);
      return;
    }
    if (visited.has(id)) return;
    active.push(id);
    for (const dependency of byId.get(id)?.dependencies ?? [])
      if (dependency !== id && byId.has(dependency)) visit(dependency);
    active.pop();
    visited.add(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return [...cyclic].sort();
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function parseValidatedToonText<A, I>(text: string, schema: Schema.Codec<A, I>, path: string): A {
  return parseSchema(schema, decodeToonText(text, path));
}
function decodeToonText(text: string, path: string): unknown {
  try {
    return decodeToon(text, { strict: true });
  } catch (error: unknown) {
    throw new IntentStoreError("malformed_toon", "Persistent work state is malformed TOON.", {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
function atomicWriteToon(path: string, value: unknown): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* atomicWriteText(path, `${encodeToon(value)}\n`);
  });
}
function atomicWriteText(path: string, text: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* assertNoSymlinkAncestors(path);
    yield* promiseEffect(() => mkdir(dirname(path), { recursive: true }));
    yield* assertNoSymlinkAncestors(path);
    const temporary = join(
      dirname(path),
      `.holycodex-write-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    {
      const recovery24 = yield* Effect.gen(function* () {
        const handle = yield* promiseEffect(() => open(temporary, "wx", 0o600));
        {
          const recovery23 = yield* Effect.gen(function* () {
            yield* promiseEffect(() => handle.writeFile(text, "utf8"));
            yield* promiseEffect(() => handle.sync());
            return { kind: "none" } as const;
          })
            .pipe(Effect.catchDefect((error) => Effect.fail(error)))
            .pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* promiseEffect(() => handle.close());
                  return { kind: "none" } as const;
                }).pipe(Effect.orDie),
              ),
            );
        }
        yield* promiseEffect(() => rename(temporary, path));
        yield* syncDirectory(dirname(path));
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                yield* promiseEffect(() => rm(temporary, { force: true }));
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
    }
  });
}
function immutableWrite(path: string, text: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* assertNoSymlinkAncestors(path);
    {
      const recovery26 = yield* Effect.gen(function* () {
        const handle = yield* promiseEffect(() => open(path, "wx", 0o400));
        {
          const recovery25 = yield* Effect.gen(function* () {
            yield* promiseEffect(() => handle.writeFile(text, "utf8"));
            yield* promiseEffect(() => handle.sync());
            return { kind: "none" } as const;
          })
            .pipe(Effect.catchDefect((error) => Effect.fail(error)))
            .pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* promiseEffect(() => handle.close());
                  return { kind: "none" } as const;
                }).pipe(Effect.orDie),
              ),
            );
        }
        yield* syncDirectory(dirname(path));
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isFsCode(error, "EEXIST"))
                  return yield* Effect.fail(
                    new IntentStoreError("archive_conflict", "Archived plans are immutable.", {
                      path,
                    }),
                  );
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
    }
  });
}
/**
 * Flush a containing directory when the platform exposes directory fsync. Windows can open a
 * directory handle, but its FlushFileBuffers/fsync operation is not a portable durability boundary;
 * file flush and atomic rename remain the durable boundary there.
 */
function syncDirectory(path: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (process.platform === "win32") return;
    {
      const recovery28 = yield* Effect.gen(function* () {
        const directory = yield* promiseEffect(() => open(path, "r"));
        {
          const recovery27 = yield* Effect.gen(function* () {
            yield* promiseEffect(() => directory.sync());
            return { kind: "none" } as const;
          })
            .pipe(Effect.catchDefect((error) => Effect.fail(error)))
            .pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* promiseEffect(() => directory.close());
                  return { kind: "none" } as const;
                }).pipe(Effect.orDie),
              ),
            );
        }
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (
                  isFsCode(error, "EINVAL") ||
                  isFsCode(error, "ENOSYS") ||
                  isFsCode(error, "ENOTSUP") ||
                  isFsCode(error, "EOPNOTSUPP") ||
                  isFsCode(error, "EISDIR")
                ) {
                  return { kind: "return", value: undefined } as const;
                }
                return yield* Effect.fail(error);
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery28.kind === "return") return recovery28.value;
    }
  });
}
/** Serializes a mutation with an exclusive directory lock. */
function withLock<A>(
  lockPath: string,
  operation: () => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  return Effect.gen(function* () {
    const parent = dirname(lockPath);
    yield* assertNoSymlinkAncestors(lockPath);
    yield* promiseEffect(() => mkdir(parent, { recursive: true }));
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      {
        const recovery30 = yield* Effect.gen(function* () {
          yield* promiseEffect(() => mkdir(lockPath));
          acquired = true;
          return { kind: "break" } as const;
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (!isFsCode(error, "EEXIST")) return yield* Effect.fail(storeIo(error));
                  {
                    const recovery29 = yield* Effect.gen(function* () {
                      const lockEntry = yield* promiseEffect(() => lstat(lockPath));
                      if (lockEntry.isSymbolicLink() || !lockEntry.isDirectory())
                        return yield* Effect.fail(
                          new IntentStoreError(
                            "schema_invalid",
                            "The work-state lock must be a real directory.",
                            { path: lockPath },
                          ),
                        );
                      const ownerState = yield* readLockOwner(lockPath);
                      if (
                        ownerState.kind === "owned" &&
                        !(yield* isProcessAlive(ownerState.owner.pid))
                      ) {
                        yield* promiseEffect(() => rm(lockPath, { recursive: true, force: true }));
                        return { kind: "continue" } as const;
                      }
                      if (
                        ownerState.kind === "missing" &&
                        Date.now() - lockEntry.mtimeMs > LOCK_STALE_MS
                      ) {
                        yield* promiseEffect(() => rm(lockPath, { recursive: true, force: true }));
                        return { kind: "continue" } as const;
                      }
                      return { kind: "none" } as const;
                    })
                      .pipe(Effect.catchDefect((error) => Effect.fail(error)))
                      .pipe(
                        Effect.catchIf(
                          () => true,
                          (lockError) =>
                            Effect.gen(function* () {
                              if (!isFsCode(lockError, "ENOENT"))
                                return yield* Effect.fail(storeIo(lockError));
                              return { kind: "none" } as const;
                            }),
                        ),
                      );
                    if (recovery29.kind === "continue") return { kind: "continue" } as const;
                  }
                  yield* Effect.sleep(Math.min(5 + attempt, 50));
                  return { kind: "none" } as const;
                }),
            ),
          );
        if (recovery30.kind === "break") break;
        if (recovery30.kind === "continue") continue;
      }
    }
    if (!acquired)
      return yield* Effect.fail(
        new IntentStoreError("stale_write", "Another mutation is still in progress.", {
          lock: lockPath,
        }),
      );
    const ownerPath = join(lockPath, ".owner");
    const ownerToken = crypto.randomUUID();
    let owner!: Awaited<ReturnType<typeof open>> | undefined;
    {
      const recovery32 = yield* Effect.gen(function* () {
        yield* assertNoSymlinkAncestors(ownerPath);
        owner = yield* promiseEffect(() => open(ownerPath, "wx", 0o600));
        yield* promiseEffect(() =>
          owner!.writeFile(`${JSON.stringify({ pid: process.pid, token: ownerToken })}\n`, "utf8"),
        );
        yield* promiseEffect(() => owner!.sync());
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (owner !== undefined) {
                  {
                    const recovery31 = yield* Effect.gen(function* () {
                      yield* promiseEffect(() => owner!.close());
                      return { kind: "none" } as const;
                    })
                      .pipe(Effect.catchDefect((error) => Effect.fail(error)))
                      .pipe(
                        Effect.catchIf(
                          () => true,
                          (ignoredError) =>
                            Effect.gen(function* () {
                              return { kind: "none" } as const;
                            }),
                        ),
                      );
                  }
                }
                if (isFsCode(error, "EEXIST"))
                  return yield* Effect.fail(
                    new IntentStoreError("stale_write", "Another mutation is still in progress.", {
                      lock: lockPath,
                    }),
                  );
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
    }
    if (owner === undefined)
      return yield* Effect.fail(storeIo(new Error("The work-state lock owner was not opened.")));
    {
      const recovery34 = yield* Effect.gen(function* () {
        return { kind: "return", value: yield* operation() } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              {
                const recovery33 = yield* Effect.gen(function* () {
                  yield* promiseEffect(() => owner!.close());
                  return { kind: "none" } as const;
                })
                  .pipe(Effect.catchDefect((error) => Effect.fail(error)))
                  .pipe(
                    Effect.ensuring(
                      Effect.gen(function* () {
                        yield* removeOwnedLock(lockPath, ownerToken);
                        return { kind: "none" } as const;
                      }).pipe(Effect.orDie),
                    ),
                  );
              }
              return { kind: "none" } as const;
            }).pipe(Effect.orDie),
          ),
        );
      if (recovery34.kind === "return") return recovery34.value;
    }
  }) as Effect.Effect<A, unknown>;
}
type LockOwnerState =
  | {
      readonly kind: "missing";
    }
  | {
      readonly kind: "owned";
      readonly owner: LockOwner;
    }
  | {
      readonly kind: "unknown";
    };
function readLockOwner(lockPath: string): Effect.Effect<LockOwnerState, unknown> {
  return Effect.gen(function* () {
    const ownerPath = join(lockPath, ".owner");
    {
      const recovery36 = yield* Effect.gen(function* () {
        const entry = yield* promiseEffect(() => lstat(ownerPath));
        if (entry.isSymbolicLink() || !entry.isFile())
          return { kind: "return", value: { kind: "unknown" } } as const;
        const text = yield* promiseEffect(() => readFile(ownerPath, "utf8"));
        let value!: unknown;
        {
          const recovery35 = yield* Effect.gen(function* () {
            value = JSON.parse(text);
            return { kind: "none" } as const;
          })
            .pipe(Effect.catchDefect((error) => Effect.fail(error)))
            .pipe(
              Effect.catchIf(
                () => true,
                (ignoredError) =>
                  Effect.gen(function* () {
                    return { kind: "return", value: { kind: "unknown" } } as const;
                    return { kind: "none" } as const;
                  }),
              ),
            );
          if (recovery35.kind === "return")
            return { kind: "return", value: recovery35.value } as const;
        }
        const decoded = decodeUnknown(LockOwnerSchema, value);
        return {
          kind: "return",
          value: Result.isSuccess(decoded)
            ? { kind: "owned", owner: decoded.success }
            : { kind: "unknown" },
        } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isFsCode(error, "ENOENT"))
                  return { kind: "return", value: { kind: "missing" } } as const;
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery36.kind === "return") return recovery36.value;
    }
  }) as Effect.Effect<LockOwnerState, unknown>;
}
function isProcessAlive(pid: number): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    // A process cannot disappear while this call is executing, and explicitly
    // recognizing our own PID avoids platform-specific process-probe quirks.
    if (pid === process.pid) return true;
    if (process.platform === "win32") return yield* isWindowsProcessAlive(pid);
    // If a future/unknown platform does not document `kill(pid, 0)`, fail
    // closed: an unverified owner must be treated as alive and retained.
    const supportedPlatforms = [
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "openbsd",
      "sunos",
      "win32",
    ] as const;
    if (!(supportedPlatforms as readonly string[]).includes(process.platform)) return true;
    {
      const recovery37 = yield* Effect.gen(function* () {
        process.kill(pid, 0);
        return { kind: "return", value: true } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                return { kind: "return", value: isFsCode(error, "EPERM") } as const;
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery37.kind === "return") return recovery37.value;
    }
  }) as Effect.Effect<boolean, unknown>;
}
function isWindowsProcessAlive(pid: number): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    // Windows process identifiers are DWORDs. Values outside that domain make
    // tasklist reject the filter; they cannot identify a live owner and should
    // be reclaimable instead of being mistaken for an unavailable probe.
    if (!Number.isSafeInteger(pid) || pid > WINDOWS_PID_MAX) return false;
    {
      const recovery38 = yield* Effect.gen(function* () {
        const { stdout } = yield* promiseEffect(() =>
          execFileAsync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
            encoding: "utf8",
            windowsHide: true,
          }),
        );
        return {
          kind: "return",
          value: stdout
            .split(/\r?\n/u)
            .some((line) => /^"[^"]*","(\d+)",/u.exec(line)?.[1] === String(pid)),
        } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (ignoredError) =>
              Effect.gen(function* () {
                return { kind: "return", value: true } as const;
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery38.kind === "return") return recovery38.value;
    }
  }) as Effect.Effect<boolean, unknown>;
}
function removeOwnedLock(lockPath: string, ownerToken: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const ownerState = yield* readLockOwner(lockPath);
    if (ownerState.kind !== "owned" || ownerState.owner.token !== ownerToken) return;
    yield* promiseEffect(() => rm(lockPath, { recursive: true, force: true }));
  });
}
function nextArchivePath(directory: string): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const indexes = (yield* promiseEffect(() => readdir(directory)))
      .map((entry) => /^plan\.old-(\d{3})\.toon$/u.exec(entry)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    return join(
      directory,
      `plan.old-${String((indexes.length ? Math.max(...indexes) : 0) + 1).padStart(3, "0")}.toon`,
    );
  });
}
function exists(path: string): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    {
      const recovery39 = yield* Effect.gen(function* () {
        yield* promiseEffect(() => stat(path));
        return { kind: "return", value: true } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isFsCode(error, "ENOENT")) return { kind: "return", value: false } as const;
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery39.kind === "return") return recovery39.value;
    }
  }) as Effect.Effect<boolean, unknown>;
}
function isFile(path: string): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    {
      const recovery40 = yield* Effect.gen(function* () {
        const entry = yield* promiseEffect(() => lstat(path));
        return { kind: "return", value: entry.isFile() && !entry.isSymbolicLink() } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isFsCode(error, "ENOENT") || isFsCode(error, "ENOTDIR"))
                  return { kind: "return", value: false } as const;
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery40.kind === "return") return recovery40.value;
    }
  }) as Effect.Effect<boolean, unknown>;
}
function assertDirectory(path: string, allowMissing: boolean): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    {
      const recovery41 = yield* Effect.gen(function* () {
        const entry = yield* promiseEffect(() => lstat(path));
        if (entry.isSymbolicLink() || !entry.isDirectory())
          return yield* Effect.fail(
            new IntentStoreError(
              "schema_invalid",
              "Persistent work-state directories must be real directories.",
              { path },
            ),
          );
        return { kind: "return", value: true } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isFsCode(error, "ENOENT") && allowMissing)
                  return { kind: "return", value: false } as const;
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery41.kind === "return") return recovery41.value;
    }
  }) as Effect.Effect<boolean, unknown>;
}
function isDirectory(path: string): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    {
      const recovery42 = yield* Effect.gen(function* () {
        const entry = yield* promiseEffect(() => lstat(path));
        return { kind: "return", value: entry.isDirectory() && !entry.isSymbolicLink() } as const;
        return { kind: "none" } as const;
      })
        .pipe(Effect.catchDefect((error) => Effect.fail(error)))
        .pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.gen(function* () {
                if (isFsCode(error, "ENOENT") || isFsCode(error, "ENOTDIR"))
                  return { kind: "return", value: false } as const;
                return yield* Effect.fail(storeIo(error));
                return { kind: "none" } as const;
              }),
          ),
        );
      if (recovery42.kind === "return") return recovery42.value;
    }
  }) as Effect.Effect<boolean, unknown>;
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
function assertNoSymlinkAncestors(path: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    let current = resolve(path);
    while (true) {
      {
        const recovery43 = yield* Effect.gen(function* () {
          const entry = yield* promiseEffect(() => lstat(current));
          if (entry.isSymbolicLink())
            return yield* Effect.fail(
              new IntentStoreError(
                "schema_invalid",
                "Persistent work state must not contain symbolic links.",
                { path: current },
              ),
            );
          return { kind: "none" } as const;
        })
          .pipe(Effect.catchDefect((error) => Effect.fail(error)))
          .pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.gen(function* () {
                  if (!isFsCode(error, "ENOENT")) return yield* Effect.fail(storeIo(error));
                  return { kind: "none" } as const;
                }),
            ),
          );
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  });
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
function promiseEffect<A>(operation: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}
