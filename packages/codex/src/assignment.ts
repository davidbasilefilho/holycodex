// SPDX-License-Identifier: Apache-2.0

import * as Context from "effect/Context";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  decodeUnknown,
  EffortSchema,
  RoleTaskSchema,
  RouteKeySchema,
  ServiceTierSchema,
  SpecialistOutcomeSchema,
  type JsonObject,
  type JsonValue,
  type RoleTask,
  type RouteKey,
  type ServiceTier,
  type Effort,
  type SpecialistOutcome,
} from "@holycodex/core";
import {
  checked,
  CodexError,
  IdentifierSchema,
  isPlainObject,
  JsonObjectSchema,
  TextSchema,
} from "./common";
import type { AppServerClient } from "./client";
import { AppServer } from "./effect-services";
import { generatedMultiAgentV2LifecycleStatus } from "./generated-wire";
import {
  TurnCompletedNotificationSchema,
  type ModelCapability,
  type ModelListResult,
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

export const SemanticAssignmentPacketSchema = Schema.Struct({
  assignment: AssignmentSchema,
  context: JsonObjectSchema,
  route: RoutePacketSchema,
  tools: ToolPolicySchema,
  security: SecurityPolicySchema,
  compatibility: CompatibilityPacketSchema,
});
export type SemanticAssignmentPacket = typeof SemanticAssignmentPacketSchema.Type;

export const ExecutionBackendSchema = Schema.Literal("app-server-v1-fallback", "app-server-v2");
export type ExecutionBackend = typeof ExecutionBackendSchema.Type;

export const SemanticExecutionOutcomeSchema = Schema.Struct({
  assignment_id: IdentifierSchema,
  route_key: RouteKeySchema,
  thread_id: IdentifierSchema,
  turn_id: IdentifierSchema,
  backend: ExecutionBackendSchema,
  outcome: SpecialistOutcomeSchema,
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

function decodeOutcome(value: unknown): SpecialistOutcome | undefined {
  const parsed = decodeUnknown(SpecialistOutcomeSchema, value);
  return Either.isRight(parsed) ? parsed.right : undefined;
}

function findOutcome(value: unknown, depth = 0): SpecialistOutcome | undefined {
  if (depth > 8) {
    return undefined;
  }
  const direct = decodeOutcome(value);
  if (direct !== undefined) {
    return direct;
  }
  if (typeof value === "string") {
    try {
      return decodeOutcome(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of [...value].reverse()) {
      const found = findOutcome(item, depth + 1);
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
        const found = findOutcome(value[key], depth + 1);
        if (found !== undefined) {
          return found;
        }
      }
    }
    for (const item of Object.values(value).reverse()) {
      const found = findOutcome(item, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function extractOutcome(notification: TurnCompletedNotification): SpecialistOutcome | undefined {
  return findOutcome(notification);
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
  const models = await client.listModels({});
  const model = selectModel(models, packet.compatibility.model);
  validatePlanDerivedInputs(packet.compatibility, model);
  const backend = selectExecutionBackend(packet.compatibility, model);
  const thread = await client.startThread({
    model: packet.compatibility.model,
    serviceTier: packet.compatibility.service_tier,
    ephemeral: true,
  });
  const threadId = threadIdFromResult(thread);
  const waiter = waitForCompletion(client, threadId, options.timeoutMs ?? 120_000, signal);
  let turnId: string | undefined;
  let completed = false;
  try {
    const turn = await client.startTurn({
      threadId,
      input: [{ type: "text", text: packet.assignment.objective }],
      model: packet.compatibility.model,
      effort: packet.compatibility.effort,
      serviceTier: packet.compatibility.service_tier,
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
        { threadId, turnId: nativeTurnId, completedTurnId },
      );
    }
    const outcome = extractOutcome(completion) ?? findOutcome(await client.readThread(threadId));
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
        thread_id: threadId,
        turn_id: nativeTurnId,
        backend,
        outcome,
      },
      "semantic execution outcome",
    );
    completed = true;
    return result;
  } finally {
    waiter.close();
    if (turnId !== undefined && !completed) {
      await client.interruptTurn({ threadId, turnId }).catch(() => undefined);
    }
  }
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

export type AssignmentPacketParts = {
  readonly assignment: Assignment;
  readonly context: JsonObject;
  readonly route: RoutePacket;
  readonly tools: ToolPolicy;
  readonly security: SecurityPolicy;
  readonly compatibility: CompatibilityPacket;
};

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
