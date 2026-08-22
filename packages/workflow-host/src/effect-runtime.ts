// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  lookupRoute,
  lookupRoleDefinition,
  normalizeSpecialistOutcome,
  type JsonObject,
  type JsonValue,
  type RoleTask,
  type SpecialistOutcomeV2,
  type RouteDefinition,
} from "@holycodex/core";
import {
  AgentExecution,
  CodexError,
  SemanticAssignmentPacketSchema,
  SemanticExecutionOutcomeSchema,
  type AssignmentExecutionService,
  type RetainedContext,
  type SemanticAssignmentPacket,
  type SemanticExecutionOutcome,
} from "@holycodex/codex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  compileWorkflow,
  runExecutionPlan,
  type CapacityLease,
  type Assignment,
  type CompileOptions,
  type ExecutionPlan,
  type WorkflowFailure,
  type WorkflowHostServices as RuntimeWorkflowHostServices,
} from "@holycodex/workflow-runtime";
import {
  appendEvent,
  emitTelemetry,
  loadRun,
  operationLifecycle,
  writeCheckpoint,
} from "./lifecycle.ts";
import { acquireDispatch, releaseDispatch } from "./admission.ts";
import { approveBeforeDispatch } from "./approval.ts";
import { WorkflowHostError } from "./errors.ts";
import {
  admitOperationEvent,
  asJsonValue,
  findOperationEvent,
  inputDigest,
  jsonObject,
  normalizeSemanticAssignment,
  operationFingerprint,
  optionInteger,
  randomId,
  safeText,
  authorityScopeDigest,
} from "./identity.ts";
import {
  decodeHostSchema,
  RetainedSessionRefSchema,
  type RetainedContextIdentity,
  type RetainedSessionRef,
} from "./schemas.ts";
import { reuseRetainedContext } from "./replay.ts";
import type { ActiveRun, HostContext, PendingRun } from "./types.ts";
import type { RunDefinition } from "./schemas.ts";

export type CompiledWorkflowRun = Readonly<{
  readonly plan: ExecutionPlan<unknown>;
  readonly value: unknown;
}>;

export function compileHostWorkflow(
  workflow: PendingRun["workflow"],
  options: CompileOptions,
): Effect.Effect<ExecutionPlan<unknown>, WorkflowFailure> {
  if (workflow === undefined) {
    return Effect.fail({
      _tag: "WorkflowFailure",
      code: "validation",
      message: "An immutable workflow terminal is required for the Effect runtime path.",
    });
  }
  return compileWorkflow(workflow, options);
}

export function runCompiledWorkflow(
  context: HostContext,
  definition: RunDefinition,
  pending: PendingRun,
  active: ActiveRun,
  input: unknown,
  compileOptions: CompileOptions,
): Effect.Effect<CompiledWorkflowRun, WorkflowFailure> {
  const compiled =
    pending.compiledPlan === undefined
      ? compileHostWorkflow(pending.workflow, compileOptions)
      : Effect.succeed(pending.compiledPlan);
  const program = Effect.gen(function* () {
    const plan = yield* compiled;
    const services = yield* makeRuntimeServices(context, definition, pending, active, plan);
    const value = yield* runExecutionPlan(plan, input, {
      capacity: context.sharedCapacity,
      services,
      runId: definition.run_id,
    });
    return { plan, value } satisfies CompiledWorkflowRun;
  });

  const codex = context.codex;
  const codexLayer =
    context.codexLayer ??
    (codex === undefined
      ? Layer.succeed(AgentExecution, unavailableAgentExecution())
      : Layer.succeed(AgentExecution, codex));
  const providedLayer = codexLayer.pipe(
    Layer.mapError((cause) =>
      workflowFailure("execution", "The Codex AgentExecution layer could not be provided.", {
        cause,
      }),
    ),
  );
  return program.pipe(Effect.provide(providedLayer));
}

function makeRuntimeServices(
  context: HostContext,
  definition: RunDefinition,
  pending: PendingRun,
  active: ActiveRun,
  plan: ExecutionPlan<unknown>,
): Effect.Effect<RuntimeWorkflowHostServices, WorkflowFailure, AgentExecution> {
  const inherited = context.services;
  const inheritedAgent = inherited.agent;
  const codexAgent = context.codex;
  const codexLayer = context.codexLayer;
  const withAgent = (
    agent: NonNullable<RuntimeWorkflowHostServices["agent"]>,
  ): RuntimeWorkflowHostServices => ({
    ...inherited,
    agent,
    route: inherited.route ?? ((node) => routeForNode(definition, plan, node)),
    journal: inherited.journal ?? ((event) => journalRuntimeEvent(context, event)),
    approval: (request) => approveRuntimeNode(context, request),
    verification: inherited.verification ?? ((request) => verifyRuntimeNode(context, request)),
    durability: inherited.durability ?? {
      checkpoint: (event) => checkpointRuntimeNode(context, pending, event),
    },
  });

  if (inheritedAgent !== undefined) {
    return Effect.succeed(withAgent(inheritedAgent));
  }
  if (codexAgent === undefined && codexLayer === undefined) {
    return Effect.fail(
      workflowFailure("execution", "The workflow host AgentExecution capability is unavailable."),
    );
  }
  return Effect.gen(function* () {
    const agent = yield* AgentExecution;
    return withAgent({
      execute: (assignment: Assignment<unknown, unknown>) =>
        executeCodexAssignment(context, definition, pending, active, agent, assignment),
    });
  });
}

function routeForNode(
  definition: RunDefinition,
  plan: ExecutionPlan<unknown>,
  node: Readonly<{ readonly nodeId: string; readonly name: string }>,
): Effect.Effect<string, WorkflowFailure> {
  const compiledNode = plan.nodes.find((item) => item.id === node.nodeId);
  const assignmentRoute = compiledNode?.assignment.route;
  const candidate =
    assignmentRoute ?? (node.name.includes(":") ? node.name : definition.identity.route);
  const selected = lookupRoute(definition.identity.plan, candidate);
  if (!selected.ok) {
    return Effect.fail(
      workflowFailure("validation", "The compiled workflow node route is not plan-admitted.", {
        nodeId: node.nodeId,
      }),
    );
  }
  if (compiledNode === undefined) {
    return Effect.fail(
      workflowFailure("compilation", "The compiled workflow node is not in the execution plan.", {
        nodeId: node.nodeId,
      }),
    );
  }
  return Effect.succeed(selected.value.key);
}

export function executeCodexOperation(
  context: HostContext,
  definition: RunDefinition,
  pending: PendingRun,
  active: ActiveRun,
  input: Readonly<{
    readonly operationId: string;
    readonly prompt: string;
    readonly options: JsonObject;
    readonly route: string;
  }>,
): Effect.Effect<SpecialistOutcomeV2, WorkflowFailure> {
  const assignment: Assignment<unknown, unknown> = {
    payload: { objective: input.prompt, options: input.options },
    input: { name: "json", decode: (value: unknown): unknown => value },
    output: { name: "json", decode: (value: unknown): unknown => value },
    metadata: { id: input.operationId },
    route: input.route,
  };
  const codex = context.codex;
  if (codex === undefined) {
    return Effect.fail(
      workflowFailure(
        "execution",
        "The workflow host Codex AgentExecution capability is unavailable.",
      ),
    );
  }
  return Effect.gen(function* () {
    const route = yield* resolvePlanRoute(definition, input.route);
    const packet = yield* makeSemanticPacket(definition, pending, assignment, route);
    const result = yield* codex
      .execute(packet)
      .pipe(Effect.mapError((cause) => codexFailure(cause, assignment)));
    const validated = yield* validateSemanticOutcome(result, assignment, roleTaskForRoute(route));
    return validated.outcome;
  });
}

function executeCodexAssignment(
  context: HostContext,
  definition: RunDefinition,
  pending: PendingRun,
  active: ActiveRun,
  agent: AssignmentExecutionService,
  assignment: Assignment<unknown, unknown>,
): Effect.Effect<unknown, WorkflowFailure> {
  return Effect.gen(function* () {
    const route = yield* resolveAssignmentRoute(definition, assignment);
    const routeDefinition = yield* resolvePlanRoute(definition, route);
    const packet = yield* makeSemanticPacket(definition, pending, assignment, routeDefinition);
    const normalizedInput = normalizeSemanticAssignment(packet);
    const authorityDigest = yield* Effect.tryPromise({
      try: () => authorityScopeDigest(packet.assignment.authority, packet.assignment.scope),
      catch: (cause) =>
        workflowFailure("validation", "The authority scope identity could not be formed.", {
          cause,
        }),
    });
    const operationId = randomId("operation");
    const operationInput = {
      operationId,
      digest: yield* Effect.tryPromise({
        try: () => operationFingerprint(definition, normalizedInput),
        catch: (cause) =>
          workflowFailure("validation", "The assignment input is invalid.", { cause }),
      }),
      route: routeDefinition.key,
      role: routeDefinition.role,
      task: routeDefinition.task,
      attempt: assignment.metadata?.attempt ?? 1,
      retryLimit: assignment.metadata?.retries ?? 0,
      fanOut: readFanOut(assignment),
    } as const;
    const legacyDigest = yield* Effect.tryPromise({
      try: () => inputDigest(packet),
      catch: (cause) =>
        workflowFailure("validation", "The assignment input is invalid.", { cause }),
    });
    const existing = yield* Effect.tryPromise({
      try: () => loadRun(context, definition.run_id),
      catch: (cause) => toWorkflowFailure(cause, assignment),
    });
    const retainedEvent = findOperationEvent(existing.journal, operationInput.digest, legacyDigest);
    const retained = admitOperationEvent(retainedEvent);
    if (retained !== undefined) {
      return retained;
    }
    const retainedDecision = yield* Effect.tryPromise({
      try: () =>
        reuseRetainedContext(context, {
          project: definition.identity.project,
          route: routeDefinition.key,
          role: routeDefinition.role,
          task: routeDefinition.task,
          objectiveLineage: definition.objective_lineage,
          authorityScopeDigest: authorityDigest,
          policyDigest: definition.identity.policy_digest,
          toolProfile: definition.identity.tool_profile,
          securityProfile: definition.identity.security_profile,
          promptProfile: definition.identity.prompt_profile,
          approvalPolicy: definition.identity.approval_policy,
          sandboxPolicy: definition.identity.sandbox_policy,
          codexCapabilityDigest: definition.identity.codex_capability_digest,
        }),
      catch: (cause) => toWorkflowFailure(cause, assignment),
    });
    const retainedContext =
      retainedDecision.kind === "reused"
        ? retainedContextForPacket(retainedDecision.context)
        : undefined;
    const executionPacket: SemanticAssignmentPacket =
      retainedContext === undefined ? packet : { ...packet, retained_context: retainedContext };
    const controller = new AbortController();
    const startedAt = Date.now();
    const removeAbort = (): void => controller.abort();
    active.controller.signal.addEventListener("abort", removeAbort, { once: true });
    active.operationControllers.set(operationId, controller);
    let lease: CapacityLease | undefined;
    try {
      yield* appendOperation(context, definition, operationInput, "requested");
      const competing = yield* Effect.tryPromise({
        try: () => loadRun(context, definition.run_id),
        catch: (cause) => toWorkflowFailure(cause, assignment),
      });
      const competingOutcome = admitOperationEvent(
        findOperationEvent(competing.journal, operationInput.digest, legacyDigest),
        operationId,
      );
      if (competingOutcome !== undefined) {
        return competingOutcome;
      }
      lease = yield* Effect.tryPromise({
        try: () => acquireDispatch(context, active, definition.run_id),
        catch: (cause) => toWorkflowFailure(cause, assignment),
      });
      const result = yield* Effect.raceFirst(
        agent
          .execute(executionPacket)
          .pipe(Effect.mapError((cause) => codexFailure(cause, assignment))),
        cancellationEffect(controller.signal),
      );
      const validated = yield* validateSemanticOutcome(
        result,
        assignment,
        roleTaskForRoute(routeDefinition),
      );
      const session = sessionFromOutcome(
        validated.result,
        definition,
        routeDefinition,
        authorityDigest,
        operationInput.digest,
      );
      yield* appendOperation(
        context,
        definition,
        operationInput,
        "completed",
        validated.outcome,
        null,
        session,
      );
      yield* emitOperationTelemetry(
        context,
        definition,
        routeDefinition,
        "completed",
        null,
        validated.result,
      );
      return validated.outcome;
    } catch (cause) {
      const state = isUncertainCodexFailure(cause) ? "uncertain" : "failed";
      const errorCode = cause instanceof WorkflowHostError ? cause.code : "external-failed";
      yield* appendOperation(context, definition, operationInput, state, undefined, errorCode);
      yield* emitOperationTelemetry(
        context,
        definition,
        routeDefinition,
        state,
        errorCode,
        undefined,
        Date.now() - startedAt,
      );
      yield* Effect.fail(toWorkflowFailure(cause, assignment));
    } finally {
      if (lease !== undefined) {
        yield* lease.release;
        releaseDispatch(active);
      }
      active.operationControllers.delete(operationId);
      active.controller.signal.removeEventListener("abort", removeAbort);
    }
  });
}

function resolveAssignmentRoute(
  definition: RunDefinition,
  assignment: Assignment<unknown, unknown>,
): Effect.Effect<string, WorkflowFailure> {
  const route = assignment.route ?? definition.identity.route;
  const selected = lookupRoute(definition.identity.plan, route);
  return selected.ok
    ? Effect.succeed(selected.value.key)
    : Effect.fail(workflowFailure("validation", "The assignment route is not plan-admitted."));
}

function resolvePlanRoute(
  definition: RunDefinition,
  route: string,
): Effect.Effect<RouteDefinition, WorkflowFailure> {
  const selected = lookupRoute(definition.identity.plan, route);
  return selected.ok
    ? Effect.succeed(selected.value)
    : Effect.fail(workflowFailure("validation", "The assignment route is unavailable."));
}

function makeSemanticPacket(
  definition: RunDefinition,
  pending: PendingRun,
  assignment: Assignment<unknown, unknown>,
  route: RouteDefinition,
  retainedContext?: RetainedContext,
): Effect.Effect<SemanticAssignmentPacket, WorkflowFailure> {
  return Effect.try({
    try: () => {
      const payload = asJsonValue(assignment.payload, "workflow assignment payload");
      const fields = isJsonObject(payload) ? payload : {};
      const options = isJsonObject(fields["options"]) ? fields["options"] : {};
      const id = assignmentId(assignment, route.key);
      const objective = assignmentObjective(payload, id);
      const roleTask = roleTaskForRoute(route);
      const role = lookupRoleDefinition(roleTask.role);
      const evidence = readAssignmentList(fields, options, "evidence");
      const completion = readAssignmentList(fields, options, "completion");
      const delta = readAssignmentList(fields, options, "delta");
      const allowed = [
        "read",
        ...(role.permissions.write ? ["write"] : []),
        ...(role.permissions.execute ? ["execute"] : []),
        ...(role.permissions.network ? ["network"] : []),
      ];
      const packet: SemanticAssignmentPacket = {
        assignment: {
          id,
          objective,
          role_task: roleTask,
          authority: role.authority,
          scope: stableUnique([
            ...(readAssignmentList(fields, options, "scope") ?? []),
            ...(readAssignmentList(fields, options, "files") ?? []),
            ...(readAssignmentList(fields, options, "symbols") ?? []),
          ]),
          references: stableUnique(readAssignmentList(fields, options, "references") ?? []),
          constraints: stableUnique([
            ...pending.constraints,
            ...(readAssignmentList(fields, options, "constraints") ?? []),
          ]),
          required_evidence: stableUnique(evidence ?? [role.evidence]),
          acceptance: stableUnique(completion ?? [role.completion]),
          exclusions: stableUnique(readAssignmentList(fields, options, "exclusions") ?? []),
          escalation: stableUnique(readAssignmentList(fields, options, "escalation") ?? []),
          ...(delta === undefined ? {} : { delta: stableUnique(delta) }),
        },
        route: {
          key: route.key,
          role_task: roleTask,
        },
        tools: { allowed, specialist_spawn: false, workflow: false },
        security: {
          network: role.permissions.network,
          specialist_spawn: false,
          workflow: false,
        },
        compatibility: {
          model: definition.identity.plan === "Go" ? "Terra" : "Luna",
          effort: route.effort,
          service_tier: definition.identity.service_tier,
          prefer_multi_agent_v2: false,
          require_multi_agent_v2: false,
        },
        ...(retainedContext === undefined ? {} : { retained_context: retainedContext }),
      };
      const parsed = decodeSemanticPacket(packet);
      if (parsed === undefined) {
        throw new WorkflowHostError(
          "external_failed",
          "The semantic Codex assignment packet is invalid.",
        );
      }
      return parsed;
    },
    catch: (cause) =>
      workflowFailure("validation", "The semantic Codex assignment could not be formed.", {
        cause,
      }),
  });
}

function readAssignmentList(
  fields: JsonObject,
  options: JsonObject,
  field: string,
): string[] | undefined {
  const parse = (value: JsonValue | undefined): string[] | undefined => {
    if (typeof value === "string") {
      return [safeText(value)].filter((item) => item.length > 0);
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.map((item) => safeText(item)).filter((item) => item.length > 0);
    }
    return undefined;
  };
  return parse(fields[field]) ?? parse(options[field]);
}

function stableUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function decodeSemanticPacket(input: unknown): SemanticAssignmentPacket | undefined {
  return decodeHostSchema(SemanticAssignmentPacketSchema, input);
}

function assignmentId(
  assignment: Assignment<unknown, unknown>,
  route = assignment.route ?? "default",
): string {
  const metadataId = assignment.metadata?.id;
  if (typeof metadataId === "string" && metadataId.length > 0) {
    return safeText(metadataId, 128);
  }
  const serialized = canonicalJson(asJsonValue(assignment.payload, "workflow assignment payload"));
  let hash = 2166136261;
  for (const character of `${route}\u0000${serialized}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `assignment-${(hash >>> 0).toString(16)}`;
}

function assignmentObjective(payload: JsonValue, id: string): string {
  if (isJsonObject(payload) && typeof payload["objective"] === "string") {
    return safeText(payload["objective"], 4096);
  }
  return safeText(`Execute workflow assignment ${id}.`, 4096);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleTaskForRoute(route: RouteDefinition): RoleTask {
  switch (route.role) {
    case "Explorer":
      if (route.task === "lookup" || route.task === "trace") {
        return { role: "Explorer", task: route.task };
      }
      break;
    case "Librarian":
      if (route.task === "lookup" || route.task === "research") {
        return { role: "Librarian", task: route.task };
      }
      break;
    case "Worker":
      if (
        route.task === "mechanical" ||
        route.task === "implementation" ||
        route.task === "integration" ||
        route.task === "operations"
      ) {
        return { role: "Worker", task: route.task };
      }
      break;
    case "Reviewer":
      if (route.task === "plan" || route.task === "code" || route.task === "artifact") {
        return { role: "Reviewer", task: route.task };
      }
      break;
  }
  throw new WorkflowHostError("invalid_route", "The route role/task pair is inconsistent.");
}

function readFanOut(assignment: Assignment<unknown, unknown>): number {
  const payload = assignment.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const options = "options" in payload ? payload.options : undefined;
    if (typeof options === "object" && options !== null && !Array.isArray(options)) {
      return optionInteger(jsonObject(options, "assignment options"), "fan_out", 1);
    }
  }
  return 1;
}

function retainedContextForPacket(input: RetainedContextIdentity): RetainedContext | undefined {
  const session = input.session;
  if (session === undefined) {
    return undefined;
  }
  return {
    thread_id: session.thread_id,
    project: session.project,
    objective_lineage: session.objective_lineage,
    role_task: session.role_task,
    route: session.route,
    authority_scope_digest: session.authority_scope_digest,
    policy_digest: session.policy_digest,
    tool_profile: session.tool_profile,
    security_profile: session.security_profile,
    prompt_profile: session.prompt_profile,
    approval_policy: session.approval_policy,
    sandbox_policy: session.sandbox_policy,
    codex_capability_digest: session.codex_capability_digest,
    last_accepted_fingerprint: session.fingerprint,
    last_accepted_turn_id: session.turn_id,
  };
}

function sessionFromOutcome(
  result: SemanticExecutionOutcome,
  definition: RunDefinition,
  route: RouteDefinition,
  authorityDigest: string,
  fingerprint: string,
): RetainedSessionRef | undefined {
  if (result.session_mode === undefined) {
    return undefined;
  }
  const session: RetainedSessionRef = {
    thread_id: result.thread_id,
    turn_id: result.turn_id,
    session_mode: result.session_mode,
    project: definition.identity.project,
    objective_lineage: definition.objective_lineage,
    role_task: roleTaskForRoute(route),
    route: route.key,
    authority_scope_digest: authorityDigest,
    policy_digest: definition.identity.policy_digest,
    tool_profile: definition.identity.tool_profile,
    security_profile: definition.identity.security_profile,
    prompt_profile: definition.identity.prompt_profile,
    approval_policy: definition.identity.approval_policy,
    sandbox_policy: definition.identity.sandbox_policy,
    codex_capability_digest: definition.identity.codex_capability_digest,
    fingerprint,
  };
  const parsed = decodeHostSchema(RetainedSessionRefSchema, session);
  if (parsed === undefined) {
    throw new WorkflowHostError(
      "external_failed",
      "The Codex session reference is invalid and cannot be retained.",
    );
  }
  return parsed;
}

function validateSemanticOutcome(
  result: unknown,
  assignment: Assignment<unknown, unknown>,
  expectedRoute: RoleTask,
): Effect.Effect<
  Readonly<{ readonly result: SemanticExecutionOutcome; readonly outcome: SpecialistOutcomeV2 }>,
  WorkflowFailure
> {
  return Effect.try({
    try: () => {
      const parsed = decodeHostSchema(SemanticExecutionOutcomeSchema, result);
      if (parsed === undefined) {
        throw workflowFailure("validation", "The semantic execution outcome is invalid.");
      }
      if (
        parsed.assignment_id !==
        assignmentId(assignment, `${expectedRoute.role}:${expectedRoute.task}`)
      ) {
        throw workflowFailure(
          "validation",
          "The semantic outcome assignment identity is inconsistent.",
        );
      }
      if (parsed.route_key !== `${expectedRoute.role}:${expectedRoute.task}`) {
        throw workflowFailure("validation", "The semantic outcome route is inconsistent.");
      }
      const normalized = normalizeSpecialistOutcome(parsed.outcome, expectedRoute);
      if (!normalized.ok) {
        throw workflowFailure("execution", "The specialist outcome is invalid.");
      }
      if (normalized.value.status !== "completed") {
        throw workflowFailure("execution", "The specialist outcome did not complete.");
      }
      return { result: parsed, outcome: normalized.value };
    },
    catch: (cause) => toWorkflowFailure(cause, assignment),
  });
}

function cancellationEffect(signal: AbortSignal): Effect.Effect<never, WorkflowFailure> {
  return Effect.async((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(workflowFailure("cancellation", "The assignment was cancelled.")));
      return;
    }
    const onAbort = (): void =>
      resume(Effect.fail(workflowFailure("cancellation", "The assignment was cancelled.")));
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function appendOperation(
  context: HostContext,
  definition: RunDefinition,
  input: Omit<Parameters<typeof operationLifecycle>[0], "state" | "errorCode">,
  state: Parameters<typeof operationLifecycle>[0]["state"],
  outcome?: SpecialistOutcomeV2,
  errorCode: string | null = null,
  session?: RetainedSessionRef,
): Effect.Effect<void, WorkflowFailure> {
  return Effect.tryPromise({
    try: async () => {
      await appendEvent(context, definition.run_id, {
        event: "operation",
        lifecycle: operationLifecycle({ ...input, state, errorCode }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(session === undefined ? {} : { session }),
      });
    },
    catch: (cause) => toWorkflowFailure(cause),
  });
}

function journalRuntimeEvent(
  context: HostContext,
  event: import("@holycodex/workflow-runtime").WorkflowJournalEvent,
): Effect.Effect<void, WorkflowFailure> {
  return Effect.tryPromise({
    try: async () => {
      await appendEvent(context, event.runId, {
        event: "workflow",
        node_id: event.nodeId,
        type: event.type,
        attempt: event.attempt,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        error_code: event.failure?.code ?? null,
      });
      await emitTelemetry(context, {
        event: "operation",
        run_id: event.runId,
        route: null,
        status: event.type,
        duration_ms: 0,
        count: 1,
        error_code: event.failure?.code ?? null,
        replayed: false,
      });
    },
    catch: (cause) => toWorkflowFailure(cause),
  });
}

function approveRuntimeNode(
  context: HostContext,
  request: import("@holycodex/workflow-runtime").WorkflowApprovalRequest,
): Effect.Effect<void, WorkflowFailure> {
  return Effect.tryPromise({
    try: () => approveBeforeDispatch(context, request),
    catch: (cause) => toWorkflowFailure(cause),
  });
}

function verifyRuntimeNode(
  context: HostContext,
  request: import("@holycodex/workflow-runtime").WorkflowVerificationRequest,
): Effect.Effect<void, WorkflowFailure> {
  return context.verification === undefined ? Effect.void : context.verification(request);
}

function checkpointRuntimeNode(
  context: HostContext,
  pending: PendingRun,
  event: import("@holycodex/workflow-runtime").WorkflowCheckpoint,
): Effect.Effect<void, WorkflowFailure> {
  const checkpoint = context.checkpoint;
  if (checkpoint !== undefined) {
    return checkpoint(event);
  }
  return Effect.tryPromise({
    try: async () => {
      const loaded = await loadRun(context, event.runId);
      await writeCheckpoint(context, loaded.snapshot, pending.objective, pending.constraints, {
        verifiedEvidence: [`workflow node ${safeText(event.nodeId)} completed`],
        decisions: [],
        phases: ["workflow"],
        activeWork: [],
        unresolvedWork: [],
        blockers: [],
        verification: ["Effect runtime checkpoint boundary reached"],
        retainedSummaries: [],
        nextActions: [],
        usageCompleteness: "complete",
        recoverableErrors: [],
      });
    },
    catch: (cause) => toWorkflowFailure(cause),
  });
}

function emitOperationTelemetry(
  context: HostContext,
  definition: RunDefinition,
  route: RouteDefinition,
  status: string,
  errorCode: string | null,
  result?: SemanticExecutionOutcome,
  durationMs?: number,
): Effect.Effect<void, WorkflowFailure> {
  return Effect.tryPromise({
    try: async () => {
      await emitTelemetry(context, {
        event: "operation",
        run_id: definition.run_id,
        route: route.key,
        ...(result?.session_mode === undefined ? {} : { session_mode: result.session_mode }),
        ...(result?.usage === undefined ? {} : { usage: result.usage }),
        status,
        duration_ms: durationMs ?? result?.duration_ms ?? 0,
        count: 1,
        error_code: errorCode,
        replayed: false,
      });
    },
    catch: (cause) => toWorkflowFailure(cause),
  });
}

function codexFailure(cause: unknown, assignment: Assignment<unknown, unknown>): WorkflowFailure {
  return workflowFailure("execution", "Codex assignment execution failed.", {
    nodeId: assignmentId(assignment),
    cause,
    retryable: false,
  });
}

function toWorkflowFailure(
  cause: unknown,
  assignment?: Assignment<unknown, unknown>,
): WorkflowFailure {
  if (isWorkflowFailureLike(cause)) {
    return cause;
  }
  return workflowFailure("execution", "The workflow host effect failed.", {
    ...(assignment === undefined ? {} : { nodeId: assignmentId(assignment) }),
    cause,
  });
}

function isWorkflowFailureLike(value: unknown): value is WorkflowFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "WorkflowFailure" &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function isUncertainCodexFailure(cause: unknown): boolean {
  if (isWorkflowFailureLike(cause) && cause.code === "cancellation") {
    return true;
  }
  return (
    cause instanceof CodexError &&
    ["execution_failed", "cancellation", "timeout", "transport_failure", "turn_failed"].includes(
      cause.code,
    )
  );
}

function unavailableAgentExecution(): AssignmentExecutionService {
  return {
    execute: () =>
      Effect.fail(
        new CodexError(
          "capability_unavailable",
          "The Codex AgentExecution capability is unavailable.",
        ),
      ),
  };
}

function workflowFailure(
  code: WorkflowFailure["code"],
  message: string,
  details: Readonly<{
    readonly nodeId?: string;
    readonly cause?: unknown;
    readonly retryable?: boolean;
  }> = {},
): WorkflowFailure {
  return Object.freeze({ _tag: "WorkflowFailure" as const, code, message, ...details });
}
