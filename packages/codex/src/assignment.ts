// SPDX-License-Identifier: Apache-2.0

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  EffortSchema,
  lookupRoleDefinition,
  normalizeSpecialistOutcome,
  RoleTaskSchema,
  RouteKeySchema,
  ServiceTierSchema,
  SPECIALIST_OUTCOME_VERSION,
  SpecialistOutcomeV2Schema,
  type JsonValue,
  type RoleTask,
  type RouteKey,
  type ServiceTier,
  type Effort,
  type SpecialistOutcomeV2,
} from "@holycodex/core";
import { checked, CodexError, IdentifierSchema, isPlainObject, TextSchema } from "./common";
import type { AppServerClient } from "./client";
import { AppServer } from "./effect-services";
import { generatedMultiAgentV2LifecycleStatus } from "./generated-wire";
import {
  TurnCompletedNotificationSchema,
  type ModelCapability,
  type ModelListResult,
  type SupportedUsage,
  type TurnCompletedNotification,
} from "./protocol";

const ToolPolicySchema = Schema.Struct({
  allowed: Schema.Array(Schema.String),
  specialist_spawn: Schema.Literal(false),
  workflow: Schema.Literal(false),
});
export type ToolPolicy = typeof ToolPolicySchema.Type;

const SecurityPolicySchema = Schema.Struct({
  network: Schema.Boolean,
  specialist_spawn: Schema.Literal(false),
  workflow: Schema.Literal(false),
});
export type SecurityPolicy = typeof SecurityPolicySchema.Type;

const AssignmentSchema = Schema.Struct({
  id: IdentifierSchema,
  objective: TextSchema,
  role_task: RoleTaskSchema,
  authority: TextSchema,
  scope: Schema.Array(TextSchema),
  references: Schema.Array(TextSchema),
  constraints: Schema.Array(TextSchema),
  required_evidence: Schema.Array(TextSchema),
  acceptance: Schema.Array(TextSchema),
  exclusions: Schema.Array(TextSchema),
  escalation: Schema.Array(TextSchema),
  delta: Schema.optional(Schema.Array(TextSchema)),
});
export type Assignment = typeof AssignmentSchema.Type;

const RoutePacketSchema = Schema.Struct({
  key: RouteKeySchema,
  role_task: RoleTaskSchema,
});
export type RoutePacket = typeof RoutePacketSchema.Type;

const CompatibilityPacketSchema = Schema.Struct({
  model: TextSchema,
  effort: EffortSchema,
  service_tier: ServiceTierSchema,
  prefer_multi_agent_v2: Schema.Boolean,
  require_multi_agent_v2: Schema.Boolean,
});
export type CompatibilityPacket = typeof CompatibilityPacketSchema.Type;

const DigestSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const ProjectTrustIdentitySchema = Schema.Struct({
  project_id: IdentifierSchema,
  trust_id: IdentifierSchema,
  project_digest: DigestSchema,
  trust_digest: DigestSchema,
});
const RetainedContextFieldsSchema = {
  thread_id: Schema.optional(IdentifierSchema),
  project: Schema.optional(ProjectTrustIdentitySchema),
  objective_lineage: Schema.optional(IdentifierSchema),
  role_task: Schema.optional(RoleTaskSchema),
  route: Schema.optional(RouteKeySchema),
  authority_scope_digest: Schema.optional(DigestSchema),
  policy_digest: Schema.optional(DigestSchema),
  tool_profile: Schema.optional(IdentifierSchema),
  security_profile: Schema.optional(IdentifierSchema),
  prompt_profile: Schema.optional(IdentifierSchema),
  approval_policy: Schema.optional(IdentifierSchema),
  sandbox_policy: Schema.optional(IdentifierSchema),
  codex_capability_digest: Schema.optional(DigestSchema),
  last_accepted_fingerprint: Schema.optional(DigestSchema),
  last_accepted_turn_id: Schema.optional(IdentifierSchema),
} as const;
export const RetainedContextSchema = Schema.Struct(RetainedContextFieldsSchema);
const CompleteRetainedContextSchema = Schema.Struct({
  thread_id: IdentifierSchema,
  project: ProjectTrustIdentitySchema,
  objective_lineage: IdentifierSchema,
  role_task: RoleTaskSchema,
  route: RouteKeySchema,
  authority_scope_digest: DigestSchema,
  policy_digest: DigestSchema,
  tool_profile: IdentifierSchema,
  security_profile: IdentifierSchema,
  prompt_profile: IdentifierSchema,
  approval_policy: IdentifierSchema,
  sandbox_policy: IdentifierSchema,
  codex_capability_digest: DigestSchema,
  last_accepted_fingerprint: DigestSchema,
  last_accepted_turn_id: IdentifierSchema,
});
export type RetainedContext = typeof RetainedContextSchema.Type;
type CompleteRetainedContext = typeof CompleteRetainedContextSchema.Type;

export const SessionModeSchema = Schema.Literal("fresh", "resumed");
export type SessionMode = typeof SessionModeSchema.Type;

const TokenCountSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));
export const ExecutionUsageSchema = Schema.Struct({
  input_tokens: TokenCountSchema,
  cached_input_tokens: TokenCountSchema,
  output_tokens: TokenCountSchema,
  reasoning_output_tokens: TokenCountSchema,
  total_tokens: Schema.optional(TokenCountSchema),
});
export type ExecutionUsage = typeof ExecutionUsageSchema.Type;

export const SemanticAssignmentPacketSchema = Schema.Struct({
  assignment: AssignmentSchema,
  route: RoutePacketSchema,
  tools: ToolPolicySchema,
  security: SecurityPolicySchema,
  compatibility: CompatibilityPacketSchema,
  retained_context: Schema.optional(RetainedContextSchema),
});
export type SemanticAssignmentPacket = typeof SemanticAssignmentPacketSchema.Type;

const ASSIGNMENT_FIELDS = [
  ["scope", "Scope"],
  ["references", "References"],
  ["constraints", "Constraints"],
  ["required_evidence", "Required evidence"],
  ["acceptance", "Acceptance"],
  ["exclusions", "Exclusions"],
  ["escalation", "Escalation"],
  ["delta", "Delta"],
] as const;

/** Compiles semantic state into the one literal instruction sent to a managed specialist. */
export function compileSpecialistAssignment(packet: SemanticAssignmentPacket): string {
  const lines = [
    `Assignment ID: ${packet.assignment.id}`,
    `Objective: ${packet.assignment.objective}`,
    `Role/task: ${packet.assignment.role_task.role}/${packet.assignment.role_task.task}`,
    `Authority: ${packet.assignment.authority}`,
  ];
  const retained = completeRetainedContext(packet.retained_context);
  const fields =
    retained !== undefined && hasNonEmptyDelta(packet.assignment.delta)
      ? ([
          ["delta", "Delta"],
          ["required_evidence", "Required evidence"],
          ["acceptance", "Acceptance"],
        ] as const)
      : ASSIGNMENT_FIELDS;
  for (const [field, label] of fields) {
    const value = packet.assignment[field];
    if (value !== undefined && value.length > 0) {
      lines.push(`${label}: ${value.join("; ")}`);
    }
  }
  lines.push(
    `Outcome protocol: ${SPECIALIST_OUTCOME_VERSION}; terminal shapes: completed {protocol_version,route,evidence,status,summary}; blocked {protocol_version,route,evidence,status,reason,needs_root_decision}; partial {protocol_version,route,evidence,status,summary,completed,remaining,needs_root_decision}; failed {protocol_version,route,evidence,status,error}.`,
  );
  lines.push("Boundary: Do not delegate or broaden scope; return material choices to Root.");
  return lines.join("\n");
}

export const ExecutionBackendSchema = Schema.Literal("app-server-v1-fallback", "app-server-v2");
export type ExecutionBackend = typeof ExecutionBackendSchema.Type;

export const SemanticExecutionOutcomeSchema = Schema.Struct({
  assignment_id: IdentifierSchema,
  route_key: RouteKeySchema,
  thread_id: IdentifierSchema,
  turn_id: IdentifierSchema,
  backend: ExecutionBackendSchema,
  session_mode: Schema.optional(SessionModeSchema),
  duration_ms: Schema.optional(TokenCountSchema),
  usage: Schema.optional(ExecutionUsageSchema),
  outcome: SpecialistOutcomeV2Schema,
});
export type SemanticExecutionOutcome = typeof SemanticExecutionOutcomeSchema.Type;

export interface AssignmentExecutionOptions {
  readonly timeoutMs?: number;
}

export const AssignmentExecutionOptionsSchema = Schema.Struct({
  timeoutMs: Schema.optional(
    Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value > 0)),
  ),
});

function failureFromUnknown(error: unknown, fallback: string): CodexError {
  if (error instanceof CodexError) {
    return error;
  }
  return new CodexError("execution_failed", fallback, {}, { cause: error });
}

function assertStructuralLeaf(input: unknown): void {
  if (!isPlainObject(input)) {
    return;
  }
  for (const field of ["tools", "security"] as const) {
    const profile = input[field];
    if (!isPlainObject(profile)) {
      continue;
    }
    if (profile["specialist_spawn"] === true || profile["workflow"] === true) {
      throw new CodexError(
        "route_incompatible",
        "A specialist execution packet requests a forbidden nested capability.",
        { field, needs_root_decision: true },
      );
    }
  }
}

function assertAssignmentConsistency(packet: SemanticAssignmentPacket): void {
  const assignment = packet.assignment;
  const roleTask = assignment.role_task;
  const route = packet.route.role_task;
  const definition = lookupRoleDefinition(roleTask.role);
  if (assignment.authority !== definition.authority) {
    throw new CodexError(
      "route_incompatible",
      "The assignment authority does not match the selected role catalog definition.",
      { role: roleTask.role, needs_root_decision: true },
    );
  }
  if (
    roleTask.role !== route.role ||
    roleTask.task !== route.task ||
    packet.route.key !== `${roleTask.role}:${roleTask.task}`
  ) {
    throw new CodexError("route_incompatible", "The assignment and route identities disagree.", {
      needs_root_decision: true,
    });
  }
  const expectedCapabilities = [
    "read",
    ...(definition.permissions.write ? ["write"] : []),
    ...(definition.permissions.execute ? ["execute"] : []),
    ...(definition.permissions.network ? ["network"] : []),
  ];
  if (
    packet.tools.allowed.some((capability) => !expectedCapabilities.includes(capability)) ||
    (packet.security.network && !definition.permissions.network)
  ) {
    throw new CodexError(
      "route_incompatible",
      "The assignment capabilities exceed the selected role catalog definition.",
      { role: roleTask.role, needs_root_decision: true },
    );
  }
}

function completeRetainedContext(
  input: RetainedContext | undefined,
): CompleteRetainedContext | undefined {
  if (input === undefined) {
    return undefined;
  }
  try {
    const parsed = checked(CompleteRetainedContextSchema, input, "retained context");
    if (
      parsed.route !== `${parsed.role_task.role}:${parsed.role_task.task}` ||
      parsed.route !== `${input.role_task?.role ?? ""}:${input.role_task?.task ?? ""}`
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function hasNonEmptyDelta(value: readonly string[] | undefined): boolean {
  return value !== undefined && value.some((item) => item.trim().length > 0);
}

function selectModel(models: ModelListResult, requestedModel: string): ModelCapability {
  const model = models.data.find(
    (candidate) => candidate.id === requestedModel || candidate.model === requestedModel,
  );
  if (!model) {
    throw new CodexError(
      "model_unsupported",
      "The plan-derived model is not advertised by Codex.",
      {
        model: requestedModel,
      },
    );
  }
  return model;
}

function validatePlanDerivedInputs(
  compatibility: CompatibilityPacket,
  model: ModelCapability,
): void {
  if (
    model.supportedReasoningEfforts !== undefined &&
    model.supportedReasoningEfforts.length > 0 &&
    !model.supportedReasoningEfforts.some(
      (entry) => entry["reasoningEffort"] === compatibility.effort,
    )
  ) {
    throw new CodexError(
      "model_unsupported",
      "The plan-derived reasoning effort is not advertised by Codex.",
      { model: model.model, effort: compatibility.effort },
    );
  }
  if (
    model.serviceTiers !== undefined &&
    model.serviceTiers.length > 0 &&
    !model.serviceTiers.some((entry) => entry["id"] === compatibility.service_tier)
  ) {
    throw new CodexError(
      "model_unsupported",
      "The plan-derived service tier is not advertised by Codex.",
      { model: model.model, service_tier: compatibility.service_tier },
    );
  }
}

export function selectExecutionBackend(
  compatibility: CompatibilityPacket,
  model: ModelCapability,
): ExecutionBackend {
  if (compatibility.require_multi_agent_v2 && model.multiAgentVersion !== "v2") {
    throw new CodexError(
      "capability_unavailable",
      "The requested multi_agent_v2 capability is not enabled for the selected model.",
      {
        model: model.model,
        multi_agent: model.multiAgentVersion ?? "unknown",
        needs_root_decision: true,
      },
    );
  }
  if (
    (compatibility.prefer_multi_agent_v2 || compatibility.require_multi_agent_v2) &&
    model.multiAgentVersion === "v2"
  ) {
    const lifecycleStatus = generatedMultiAgentV2LifecycleStatus();
    if (lifecycleStatus !== "verified") {
      throw new CodexError(
        "protocol_mismatch",
        "Codex advertised multi_agent_v2, but the checked-in generated contract has no verified V2 lifecycle.",
        {
          multi_agent: "v2",
          generated_lifecycle: lifecycleStatus,
          needs_root_decision: true,
        },
      );
    }
    return "app-server-v2";
  }
  return "app-server-v1-fallback";
}

function threadIdFromResult(result: unknown): string {
  if (isPlainObject(result)) {
    if (typeof result["id"] === "string" && result["id"].length > 0) {
      return result["id"];
    }
    if (
      isPlainObject(result["thread"]) &&
      typeof result["thread"]["id"] === "string" &&
      result["thread"]["id"].length > 0
    ) {
      return result["thread"]["id"];
    }
  }
  throw new CodexError("turn_failed", "Codex did not return a native thread identity.");
}

function turnIdFromResult(result: unknown): string {
  if (isPlainObject(result)) {
    if (typeof result["turnId"] === "string" && result["turnId"].length > 0) {
      return result["turnId"];
    }
    if (typeof result["id"] === "string" && result["id"].length > 0) {
      return result["id"];
    }
    if (
      isPlainObject(result["turn"]) &&
      typeof result["turn"]["id"] === "string" &&
      result["turn"]["id"].length > 0
    ) {
      return result["turn"]["id"];
    }
  }
  throw new CodexError("turn_failed", "Codex did not return a native turn identity.");
}

function decodeOutcome(value: unknown, expectedRoute: RoleTask): SpecialistOutcomeV2 | undefined {
  const parsed = normalizeSpecialistOutcome(value, expectedRoute);
  return parsed.ok ? parsed.value : undefined;
}

function findOutcome(
  value: unknown,
  expectedRoute: RoleTask,
  depth = 0,
): SpecialistOutcomeV2 | undefined {
  if (depth > 8) {
    return undefined;
  }
  const direct = decodeOutcome(value, expectedRoute);
  if (direct !== undefined) {
    return direct;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return decodeOutcome(parsed, expectedRoute);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of [...value].reverse()) {
      const found = findOutcome(item, expectedRoute, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    const preferredKeys = ["outcome", "final", "message", "content", "items", "messages", "turns"];
    for (const key of preferredKeys) {
      if (key in value) {
        const found = findOutcome(value[key], expectedRoute, depth + 1);
        if (found !== undefined) {
          return found;
        }
      }
    }
    for (const item of Object.values(value).reverse()) {
      const found = findOutcome(item, expectedRoute, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function extractOutcome(
  notification: TurnCompletedNotification,
  expectedRoute: RoleTask,
): SpecialistOutcomeV2 | undefined {
  return findOutcome(notification, expectedRoute);
}

interface CompletionWaiter {
  readonly promise: Promise<TurnCompletedNotification>;
  readonly setTurnId: (turnId: string) => void;
  readonly close: () => void;
}

function waitForCompletion(
  client: AppServerClient,
  threadId: string,
  timeoutMs: number,
  signal: AbortSignal,
): CompletionWaiter {
  let cleanup = (): void => undefined;
  let settled = false;
  let expectedTurnId: string | undefined;
  const earlyCompletions: Array<{
    readonly notification: TurnCompletedNotification;
    readonly turnId: string;
  }> = [];
  let resolveCompletion: (notification: TurnCompletedNotification) => void = () => undefined;
  let rejectCompletion: (error: CodexError) => void = () => undefined;
  const promise = new Promise<TurnCompletedNotification>((resolve, reject) => {
    resolveCompletion = (notification) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(notification);
    };
    rejectCompletion = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const removeNotification = client.onNotification((notification) => {
      if (notification.kind !== "turn_completed" || notification.params === undefined) {
        return;
      }
      let completed: TurnCompletedNotification;
      try {
        completed = checked(
          // Notification input has already crossed the wire schema; this maps it to the small domain shape.
          TurnCompletedNotificationSchema,
          notification.params,
          "turn/completed notification",
        );
      } catch (error: unknown) {
        rejectCompletion(failureFromUnknown(error, "Codex emitted an invalid turn completion."));
        return;
      }
      if (completed.threadId !== threadId) {
        return;
      }
      let completedTurnId: string;
      try {
        completedTurnId = turnIdFromResult(completed);
      } catch (error: unknown) {
        rejectCompletion(failureFromUnknown(error, "Codex emitted an invalid turn completion."));
        return;
      }
      if (expectedTurnId === undefined) {
        earlyCompletions.push({ notification: completed, turnId: completedTurnId });
        return;
      }
      if (completedTurnId === expectedTurnId) {
        resolveCompletion(completed);
      }
    });
    timeout = setTimeout(() => {
      rejectCompletion(
        new CodexError("timeout", "The Codex turn did not complete before the deadline."),
      );
    }, timeoutMs);
    const abort = (): void => {
      rejectCompletion(new CodexError("cancellation", "The Codex turn was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    cleanup = () => {
      removeNotification();
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", abort);
    };
  });
  void promise.catch(() => undefined);
  const setTurnId = (turnId: string): void => {
    if (settled) {
      return;
    }
    expectedTurnId = turnId;
    const matchingIndex = earlyCompletions.findIndex((completion) => completion.turnId === turnId);
    if (matchingIndex >= 0) {
      const matching = earlyCompletions[matchingIndex];
      earlyCompletions.splice(matchingIndex, 1);
      if (matching !== undefined) {
        resolveCompletion(matching.notification);
      }
    }
  };
  const close = (): void => {
    rejectCompletion(new CodexError("closed", "The Codex turn completion waiter is closed."));
  };
  return { promise, setTurnId, close };
}

async function executeAssignmentWithClient(
  client: AppServerClient,
  packet: SemanticAssignmentPacket,
  options: AssignmentExecutionOptions,
  signal: AbortSignal,
): Promise<SemanticExecutionOutcome> {
  const startedAt = performance.now();
  const models = await client.listModels({});
  const model = selectModel(models, packet.compatibility.model);
  validatePlanDerivedInputs(packet.compatibility, model);
  const backend = selectExecutionBackend(packet.compatibility, model);
  const completeRetained = completeRetainedContext(packet.retained_context);
  const retained = hasNonEmptyDelta(packet.assignment.delta) ? completeRetained : undefined;
  if (
    retained !== undefined &&
    (retained.route !== packet.route.key ||
      retained.role_task.role !== packet.assignment.role_task.role ||
      retained.role_task.task !== packet.assignment.role_task.task)
  ) {
    throw new CodexError(
      "route_incompatible",
      "The retained context route does not match the assignment route.",
      { needs_root_decision: true },
    );
  }
  const sessionMode: SessionMode = retained === undefined ? "fresh" : "resumed";
  let activeThreadId: string;
  if (retained !== undefined) {
    const resumed = await client.resumeThread(retained.thread_id);
    const resumedThreadId = threadIdFromResult(resumed);
    if (resumedThreadId !== retained.thread_id) {
      throw new CodexError(
        "turn_failed",
        "Codex resumed a different thread than the retained identity.",
        { expectedThreadId: retained.thread_id, resumedThreadId },
      );
    }
    activeThreadId = resumedThreadId;
  } else {
    const thread = await client.startThread({
      model: packet.compatibility.model,
      serviceTier: packet.compatibility.service_tier,
      ephemeral: false,
    });
    activeThreadId = threadIdFromResult(thread);
  }
  const threadIdForExecution = activeThreadId;
  const waiter = waitForCompletion(
    client,
    threadIdForExecution,
    options.timeoutMs ?? 120_000,
    signal,
  );
  let turnId: string | undefined;
  let completed = false;
  try {
    const turn = await client.startTurn({
      threadId: threadIdForExecution,
      input: [{ type: "text", text: compileSpecialistAssignment(packet) }],
      model: packet.compatibility.model,
      effort: packet.compatibility.effort,
      serviceTier: packet.compatibility.service_tier,
      ...(packet.assignment.role_task.role === "Explorer" ||
      packet.assignment.role_task.role === "Librarian"
        ? {
            sandboxPolicy: {
              type: "readOnly",
              networkAccess: packet.security.network,
            },
          }
        : {}),
    });
    const nativeTurnId = turnIdFromResult(turn);
    turnId = nativeTurnId;
    waiter.setTurnId(nativeTurnId);
    const completion = await waiter.promise;
    const completedTurnId = turnIdFromResult(completion);
    if (completedTurnId !== nativeTurnId) {
      throw new CodexError(
        "turn_failed",
        "Codex completed a different turn than the one started for this assignment.",
        { threadId: threadIdForExecution, turnId: nativeTurnId, completedTurnId },
      );
    }
    const outcome =
      extractOutcome(completion, packet.assignment.role_task) ??
      findOutcome(await client.readThread(threadIdForExecution), packet.assignment.role_task);
    if (outcome === undefined) {
      throw new CodexError(
        "turn_failed",
        "Codex completed a turn without a validated HolyCodex specialist outcome.",
        { needs_root_decision: true },
      );
    }
    const result = checked(
      SemanticExecutionOutcomeSchema,
      {
        assignment_id: packet.assignment.id,
        route_key: packet.route.key,
        thread_id: threadIdForExecution,
        turn_id: nativeTurnId,
        backend,
        session_mode: sessionMode,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(completion.turn?.usage === undefined
          ? {}
          : { usage: normalizeUsage(completion.turn.usage) }),
        outcome,
      },
      "semantic execution outcome",
    );
    completed = true;
    return result;
  } finally {
    waiter.close();
    if (turnId !== undefined && !completed) {
      await client.interruptTurn({ threadId: threadIdForExecution, turnId }).catch(() => undefined);
    }
  }
}

function normalizeUsage(usage: SupportedUsage): ExecutionUsage {
  return {
    input_tokens: usage.inputTokens ?? usage.input_tokens ?? 0,
    cached_input_tokens: usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0,
    output_tokens: usage.outputTokens ?? usage.output_tokens ?? 0,
    reasoning_output_tokens: usage.reasoningOutputTokens ?? usage.reasoning_output_tokens ?? 0,
    ...(usage.totalTokens === undefined && usage.total_tokens === undefined
      ? {}
      : { total_tokens: usage.totalTokens ?? usage.total_tokens }),
  };
}

export function executeAssignment(
  client: AppServerClient,
  input: unknown,
  options: AssignmentExecutionOptions = {},
): Effect.Effect<SemanticExecutionOutcome, CodexError> {
  return Effect.tryPromise({
    try: async (signal) => {
      assertStructuralLeaf(input);
      const packet = checked(SemanticAssignmentPacketSchema, input, "semantic assignment packet");
      assertAssignmentConsistency(packet);
      const validatedOptions = checked(
        AssignmentExecutionOptionsSchema,
        options,
        "assignment execution options",
      );
      return await executeAssignmentWithClient(
        client,
        packet,
        validatedOptions.timeoutMs === undefined ? {} : { timeoutMs: validatedOptions.timeoutMs },
        signal,
      );
    },
    catch: (error) => failureFromUnknown(error, "Codex assignment execution failed."),
  });
}

export interface AssignmentExecutionService {
  readonly execute: (
    input: unknown,
    options?: AssignmentExecutionOptions,
  ) => Effect.Effect<SemanticExecutionOutcome, CodexError>;
}

export class AssignmentExecution extends Context.Tag("@holycodex/codex/AssignmentExecution")<
  AssignmentExecution,
  AssignmentExecutionService
>() {}

export const AssignmentExecutionLive = Layer.effect(
  AssignmentExecution,
  Effect.gen(function* () {
    const appServer = yield* AppServer;
    return {
      execute: (input: unknown, options: AssignmentExecutionOptions = {}) =>
        executeAssignment(appServer.client, input, options),
    } satisfies AssignmentExecutionService;
  }),
);

export class AgentExecution extends Context.Tag("@holycodex/codex/AgentExecution")<
  AgentExecution,
  AssignmentExecutionService
>() {}

export const AgentExecutionLive = Layer.effect(
  AgentExecution,
  Effect.gen(function* () {
    const appServer = yield* AppServer;
    return {
      execute: (input: unknown, options: AssignmentExecutionOptions = {}) =>
        executeAssignment(appServer.client, input, options),
    } satisfies AssignmentExecutionService;
  }),
);

export type AssignmentPlanInputs = {
  readonly model: string;
  readonly effort: Effort;
  readonly service_tier: ServiceTier;
  readonly route_key: RouteKey;
  readonly role_task: RoleTask;
  readonly input: JsonValue;
};

export const CapabilityMatrixSchemaForHost = Schema.Struct({
  multi_agent: Schema.Literal("stable", "disabled", "unknown"),
  multi_agent_v2: Schema.Literal("stable", "disabled", "unknown"),
});
export type CapabilityMatrixForHost = typeof CapabilityMatrixSchemaForHost.Type;

export function detectCapabilityMatrix(model: ModelCapability): CapabilityMatrixForHost {
  const lifecycleStatus = generatedMultiAgentV2LifecycleStatus();
  return checked(
    CapabilityMatrixSchemaForHost,
    {
      multi_agent:
        model.multiAgentVersion === "v1"
          ? "stable"
          : model.multiAgentVersion === "disabled"
            ? "disabled"
            : "unknown",
      multi_agent_v2:
        model.multiAgentVersion === "v2"
          ? lifecycleStatus === "verified"
            ? "stable"
            : "unknown"
          : "disabled",
    },
    "Codex capability matrix",
  );
}
