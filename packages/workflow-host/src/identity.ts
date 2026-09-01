// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  normalizeSpecialistOutcome,
  RouteKeySchema,
  RoleTaskSchema,
  SPECIALIST_OUTCOME_VERSION,
  STATE_SCHEMA_EPOCH,
  type JsonObject,
  type JsonValue,
  type PlanDefinition,
  type RouteKey,
  type ServiceTier,
  type RoleTask,
  type SpecialistOutcomeV2,
} from "@holycodex/core";
import { createHash } from "node:crypto";
import { SemanticAssignmentPacketSchema, type SemanticAssignmentPacket } from "@holycodex/codex";
import type { CompileOptions, NativeWorkflow } from "@holycodex/workflow-runtime";
import {
  IdentityComponentsSchema,
  CompatibilityCardinalitySchema,
  NativeWorkflowIdentitySchema,
  JsonObjectSchema,
  JsonValueSchema,
  ProjectTrustRefSchema,
  SchemaEpochsSchema,
  WORKFLOW_HOST_SCHEMA_EPOCH,
  decodeHostSchema,
  type IdentityComponents,
  type JournalEvent,
  type ProjectTrustRef,
  type SchemaEpochs,
  type NativeWorkflowIdentity,
  type CompatibilityCardinality,
  type WorkflowExecutionIdentity,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import type { HostContext, ProjectTrustInput, WorkflowDefinition } from "./types.ts";

export const ZERO_DIGEST = "0".repeat(64);
export const DEFAULT_PROFILE = "default";
export const DEFAULT_ROUTE: RouteKey = "Worker:implementation";
export const MAX_PENDING_TEXT = Number.MAX_SAFE_INTEGER;

const MECHANICAL_OPERATION_FIELDS = new Set([
  "attempt",
  "attempt_count",
  "created_at",
  "fan_out",
  "operation_id",
  "retry",
  "retry_count",
  "retries",
  "run_id",
  "timestamp",
]);

export type NormalizedOperationInput = Readonly<{
  readonly route: RouteKey;
  readonly roleTask: RoleTask;
  readonly semantic: JsonValue;
  readonly protocolVersion: string;
}>;

type OperationEvent = Extract<JournalEvent, { event: "operation" }>;

export function now(): string {
  return new Date().toISOString();
}

export function safeText(value: string, _limit?: number): string {
  if (typeof value !== "string") {
    throw new WorkflowHostError("invalid_input", "A bounded text value is invalid.");
  }
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      output += " ";
    } else {
      output += character;
    }
  }
  return output.replace(/\s+/gu, " ").trim();
}

export function safeTextArray(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new WorkflowHostError("invalid_input", "A bounded text list is invalid.");
  }
  return values.map((value) => safeText(value));
}

export function assertDigest(value: string | undefined, field: string): string {
  const digest = value ?? ZERO_DIGEST;
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new WorkflowHostError("invalid_input", `The ${field} is not a SHA-256 digest.`);
  }
  return digest;
}

export function assertIdentifier(value: string | undefined, field: string): string {
  const identifier = value ?? DEFAULT_PROFILE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identifier)) {
    throw new WorkflowHostError("invalid_input", `The ${field} is not a safe identifier.`);
  }
  return identifier;
}

export function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`;
}

export function asJsonValue(value: unknown, field: string): JsonValue {
  const parsed = decodeHostSchema(JsonValueSchema, value);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", `The ${field} must be valid JSON.`);
  }
  return parsed;
}

export function normalizeProjectTrust(input: ProjectTrustInput): ProjectTrustRef {
  if (typeof input !== "object" || input === null) {
    throw new WorkflowHostError("invalid_input", "The project/trust identity is invalid.");
  }
  const candidate =
    "project_id" in input
      ? input
      : {
          project_id: input.projectId,
          trust_id: input.trustId,
          project_digest: input.projectDigest,
          trust_digest: input.trustDigest,
        };
  const parsed = decodeHostSchema(ProjectTrustRefSchema, candidate);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", "The project/trust identity is invalid.");
  }
  return parsed;
}

export function normalizeEpochs(): SchemaEpochs {
  const parsed = decodeHostSchema(SchemaEpochsSchema, {
    core: STATE_SCHEMA_EPOCH,
    runtime: "runtime-1.0",
    host: WORKFLOW_HOST_SCHEMA_EPOCH,
  });
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", "The host schema epochs are invalid.");
  }
  return parsed;
}

export function operationRoute(options: JsonObject, role: string, task: string): RouteKey {
  const suppliedRoute = options["route"];
  if (suppliedRoute !== undefined && typeof suppliedRoute !== "string") {
    throw new WorkflowHostError("invalid_route", "The workflow operation route is invalid.");
  }
  const route = suppliedRoute ?? `${role}:${task}`;
  const parsed = decodeHostSchema(RouteKeySchema, route);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_route", "The workflow operation route is invalid.");
  }
  return parsed;
}

export function optionInteger(options: JsonObject, key: string, fallback: number): number {
  const value = options[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WorkflowHostError("invalid_input", `The workflow operation ${key} is invalid.`);
  }
  return value;
}

export function sanitizeOutcome(value: unknown, expectedRoute: RoleTask): SpecialistOutcomeV2 {
  const parsed = normalizeSpecialistOutcome(value, expectedRoute);
  if (!parsed.ok) {
    throw new WorkflowHostError("specialist_invalid", "The specialist outcome is invalid.");
  }
  const outcome = parsed.value;
  const common = {
    protocol_version: outcome.protocol_version,
    route: outcome.route,
    evidence: safeTextArray(outcome.evidence),
  } as const;
  switch (outcome.status) {
    case "blocked":
      return {
        ...common,
        status: outcome.status,
        reason: safeText(outcome.reason),
        needs_root_decision: outcome.needs_root_decision,
      };
    case "completed":
      return { ...common, status: outcome.status, summary: safeText(outcome.summary) };
    case "failed":
      return { ...common, status: outcome.status, error: safeText(outcome.error) };
    case "partial":
      return {
        ...common,
        status: outcome.status,
        summary: safeText(outcome.summary),
        completed: safeTextArray(outcome.completed),
        remaining: safeTextArray(outcome.remaining),
        needs_root_decision: outcome.needs_root_decision,
      };
  }
}

export function jsonObject(value: unknown, field: string): JsonObject {
  const bounded = asJsonValue(value, field);
  const parsed = decodeHostSchema(JsonObjectSchema, bounded);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", `The ${field} must be a JSON object.`);
  }
  return parsed;
}

export async function inputDigest(value: unknown): Promise<string> {
  return await domainSeparatedSha256("workflow-operation-input", [
    canonicalJsonUtf8(asJsonValue(value, "operation input")),
  ]);
}

export async function compatibilityProofDigest(
  source: string,
  expectedCalls: number,
): Promise<string> {
  return await domainSeparatedSha256("workflow-compatibility-cardinality-v1", [
    canonicalJsonUtf8({
      proof_version: "explicit-declaration-v1",
      source_sha256: sha256(new TextEncoder().encode(source)),
      expected_calls: expectedCalls,
    }),
  ]);
}

export async function classifyCompatibilityCardinality(
  input: Readonly<{
    readonly source: string;
    readonly expectedCalls?: unknown;
    readonly proofDigest?: unknown;
  }>,
): Promise<CompatibilityCardinality> {
  if (input.expectedCalls === undefined) {
    return { status: "unknown" };
  }
  if (
    typeof input.expectedCalls !== "number" ||
    !Number.isSafeInteger(input.expectedCalls) ||
    input.expectedCalls < 0
  ) {
    return { status: "unknown" };
  }
  const proofDigest = await compatibilityProofDigest(input.source, input.expectedCalls);
  if (input.proofDigest !== undefined && input.proofDigest !== proofDigest) {
    throw new WorkflowHostError(
      "admission_denied",
      "The compatibility cardinality proof does not match the source and declaration.",
    );
  }
  const parsed = decodeHostSchema(CompatibilityCardinalitySchema, {
    status: "proven",
    expected_calls: input.expectedCalls,
    proof_digest: proofDigest,
  });
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", "The compatibility cardinality proof is invalid.");
  }
  return parsed;
}

export async function authorityScopeDigest(
  authority: string,
  scope: readonly string[],
): Promise<string> {
  return await domainSeparatedSha256("workflow-authority-scope", [
    canonicalJsonUtf8({
      authority: safeText(authority, MAX_PENDING_TEXT),
      scope: [...new Set(scope.map((item) => safeText(item)))].sort(),
    }),
  ]);
}

export function normalizeSemanticOptions(options: JsonObject): JsonObject {
  return jsonObject(
    Object.fromEntries(
      Object.entries(options).filter(
        ([key, value]) =>
          !MECHANICAL_OPERATION_FIELDS.has(key) && (key !== "delta" || hasNonEmptyDelta(value)),
      ),
    ),
    "semantic operation options",
  );
}

export function normalizeCompatibilityOperation(
  input: Readonly<{
    readonly prompt: string;
    readonly options: JsonObject;
    readonly route: RouteKey;
    readonly roleTask: RoleTask;
  }>,
): NormalizedOperationInput {
  return {
    route: input.route,
    roleTask: input.roleTask,
    semantic: {
      objective: input.prompt,
      options: normalizeSemanticOptions(input.options),
    },
    protocolVersion: SPECIALIST_OUTCOME_VERSION,
  };
}

export function normalizeSemanticAssignment(
  packet: SemanticAssignmentPacket,
): NormalizedOperationInput {
  const { id: _assignmentId, delta, ...assignment } = packet.assignment;
  return {
    route: packet.route.key,
    roleTask: packet.route.role_task,
    semantic: asJsonValue(
      {
        assignment: {
          ...assignment,
          ...(hasNonEmptyDelta(delta) ? { delta } : {}),
        },
        route: packet.route,
        skill_profile: packet.skill_profile,
        tools: packet.tools,
        security: packet.security,
        compatibility: packet.compatibility,
        ...(packet.capability_input === undefined
          ? {}
          : { capability_input: packet.capability_input }),
      },
      "semantic assignment",
    ),
    protocolVersion: SPECIALIST_OUTCOME_VERSION,
  };
}

export function normalizeOperationInput(value: unknown): NormalizedOperationInput {
  const packet = decodeHostSchema(SemanticAssignmentPacketSchema, value);
  if (packet !== undefined) {
    return normalizeSemanticAssignment(packet);
  }
  const input = jsonObject(value, "operation input");
  const prompt = input["prompt"];
  const options = input["options"];
  const route = input["route"];
  if (typeof prompt !== "string" || !isJsonObjectValue(options) || typeof route !== "string") {
    throw new WorkflowHostError("invalid_input", "The operation input is invalid.");
  }
  const parsedRoute = decodeHostSchema(RouteKeySchema, route);
  const roleTask = decodeHostSchema(RoleTaskSchema, {
    role: options["role"],
    task: options["task"],
  });
  if (parsedRoute === undefined || roleTask === undefined) {
    throw new WorkflowHostError("invalid_route", "The operation input route is invalid.");
  }
  if (`${roleTask.role}:${roleTask.task}` !== parsedRoute) {
    throw new WorkflowHostError("invalid_route", "The operation input route is inconsistent.");
  }
  return normalizeCompatibilityOperation({
    prompt,
    options,
    route: parsedRoute,
    roleTask,
  });
}

export async function operationFingerprint(
  definition: Readonly<{ readonly identity: IdentityComponents }>,
  input: NormalizedOperationInput,
): Promise<string> {
  return await domainSeparatedSha256("workflow-operation-fingerprint", [
    canonicalJsonUtf8({
      identity: definition.identity,
      operation: {
        protocol_version: input.protocolVersion,
        route: input.route,
        role_task: input.roleTask,
        semantic: input.semantic,
      },
    }),
  ]);
}

export function findOperationEvent(
  journal: readonly JournalEvent[],
  fingerprint: string,
  legacyDigest?: string,
): OperationEvent | undefined {
  const current = journal.findLast(
    (event): event is OperationEvent =>
      event.event === "operation" && event.lifecycle.operation.input_digest === fingerprint,
  );
  if (current !== undefined || legacyDigest === undefined) {
    return current;
  }
  return journal.findLast(
    (event): event is OperationEvent =>
      event.event === "operation" && event.lifecycle.operation.input_digest === legacyDigest,
  );
}

export function admitOperationEvent(
  event: OperationEvent | undefined,
  currentOperationId?: string,
): SpecialistOutcomeV2 | undefined {
  if (
    event === undefined ||
    (currentOperationId !== undefined &&
      event.lifecycle.operation.operation_id === currentOperationId)
  ) {
    return undefined;
  }
  switch (event.lifecycle.state) {
    case "completed":
      if (event.outcome === undefined) {
        throw new WorkflowHostError(
          "integrity_uncertain",
          "The completed operation has no retained outcome.",
        );
      }
      return event.outcome;
    case "reserved":
    case "requested":
    case "waiting_for_approval":
    case "approved":
      throw new WorkflowHostError(
        "identity_mismatch",
        "An operation with the same semantic fingerprint is already in flight.",
      );
    case "uncertain":
      throw new WorkflowHostError(
        "integrity_uncertain",
        "An operation with the same semantic fingerprint has an uncertain effect.",
      );
    case "failed":
      throw new WorkflowHostError(
        "no_progress",
        "An operation with the same semantic fingerprint already failed.",
      );
    case "denied":
    case "stopped":
      return undefined;
  }
}

function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNonEmptyDelta(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasNonEmptyDelta(item));
  }
  if (typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) => key.trim().length > 0 && hasNonEmptyDelta(item),
    );
  }
  return true;
}

export async function assertInputIdentity(
  definition: Readonly<{ identity: IdentityComponents }>,
  source: string,
  args: JsonValue,
): Promise<void> {
  const sourceDigest = await domainSeparatedSha256("workflow-source", [
    new TextEncoder().encode(source),
  ]);
  const argsDigest = await domainSeparatedSha256("workflow-args", [canonicalJsonUtf8(args)]);
  if (
    sourceDigest !== definition.identity.workflow_source_digest ||
    argsDigest !== definition.identity.resupplied_args_digest
  ) {
    throw new WorkflowHostError(
      "identity_mismatch",
      "Resupplied workflow source or args do not match the run identity.",
    );
  }
}

export async function assertNativeWorkflowIdentity(
  definition: Readonly<{ identity: IdentityComponents }>,
  source: string,
  workflow: WorkflowDefinition | undefined,
  compileOptions: CompileOptions,
  executionMode: "native" | "compatibility",
): Promise<void> {
  const persisted = definition.identity.native_workflow;
  if (executionMode !== "native") {
    if (persisted !== undefined) {
      throw new WorkflowHostError(
        "identity_mismatch",
        "The persisted native workflow identity cannot be resumed in compatibility mode.",
      );
    }
    return;
  }
  if (workflow !== undefined && !isNativeWorkflow(workflow)) {
    if (persisted !== undefined) {
      throw new WorkflowHostError(
        "identity_mismatch",
        "A serialized native workflow identity cannot be resumed with an in-memory DSL terminal.",
      );
    }
    return;
  }
  if (workflow === undefined || persisted === undefined) {
    throw new WorkflowHostError(
      "identity_mismatch",
      "The persisted native workflow identity requires a native workflow terminal.",
    );
  }
  const current = await buildNativeWorkflowIdentity(source, workflow, compileOptions);
  if (canonicalJson(current) !== canonicalJson(persisted)) {
    throw new WorkflowHostError(
      "identity_mismatch",
      "The supplied native workflow IR, ABI, codec profile, or source identity does not match the persisted run.",
    );
  }
}

export async function buildNativeWorkflowIdentity(
  source: string,
  workflow: NativeWorkflow,
  compileOptions: CompileOptions,
): Promise<NativeWorkflowIdentity> {
  const identity: NativeWorkflowIdentity = {
    source_sha256: sha256(new TextEncoder().encode(source)),
    ir_sha256: await domainSeparatedSha256("workflow-native-ir", [
      canonicalJsonUtf8(asJsonValue(workflow.ir, "native workflow IR")),
    ]),
    graph_sha256: await domainSeparatedSha256("workflow-native-graph", [
      canonicalJsonUtf8(asJsonValue(workflow.ir.graph, "native workflow graph")),
    ]),
    codec_profile_sha256: await domainSeparatedSha256("workflow-native-codec-profile", [
      canonicalJsonUtf8(
        asJsonValue(
          { codecs: workflow.ir.codecs, compile_options: compileOptions },
          "native workflow codec profile",
        ),
      ),
    ]),
    abi_version: workflow.ir.abiVersion,
    execution_mode: "native",
  };
  const parsed = decodeHostSchema(NativeWorkflowIdentitySchema, identity);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", "The native workflow identity is invalid.");
  }
  return parsed;
}

export async function buildIdentity(
  input: Readonly<{
    readonly source: string;
    readonly args: JsonValue;
    readonly plan: PlanDefinition;
    readonly route: RouteKey;
    readonly serviceTier: ServiceTier;
    readonly role: IdentityComponents["role"];
    readonly context: HostContext;
    readonly nativeWorkflow?: WorkflowDefinition;
    readonly compileOptions?: CompileOptions;
    readonly workflowExecution?: WorkflowExecutionIdentity;
  }>,
): Promise<IdentityComponents> {
  const sourceDigest = await domainSeparatedSha256("workflow-source", [
    new TextEncoder().encode(input.source),
  ]);
  const argsDigest = await domainSeparatedSha256("workflow-args", [canonicalJsonUtf8(input.args)]);
  const planCatalogDigest = await domainSeparatedSha256("workflow-plan-catalog", [
    canonicalJsonUtf8({ plan: input.plan.name, routes: input.plan.routes }),
  ]);
  const identity: IdentityComponents = {
    project: input.context.project,
    workflow_source_digest: sourceDigest,
    resupplied_args_digest: argsDigest,
    plan_catalog_digest: planCatalogDigest,
    plan: input.plan.name,
    route: input.route,
    service_tier: input.serviceTier,
    policy_digest: input.context.policyDigest,
    prompt_profile: input.context.promptProfile,
    role: input.role,
    tool_profile: input.context.toolProfile,
    security_profile: input.context.securityProfile,
    approval_policy: input.context.approvalPolicy,
    sandbox_policy: input.context.sandboxPolicy,
    codex_capability_digest: input.context.codexCapabilityDigest,
    schema_epochs: normalizeEpochs(),
    ...(input.workflowExecution === undefined
      ? {}
      : { workflow_execution: input.workflowExecution }),
    ...(input.nativeWorkflow === undefined || !isNativeWorkflow(input.nativeWorkflow)
      ? {}
      : {
          native_workflow: await buildNativeWorkflowIdentity(
            input.source,
            input.nativeWorkflow,
            input.compileOptions ?? {},
          ),
        }),
  };
  const parsed = decodeHostSchema(IdentityComponentsSchema, identity);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", "The run identity could not be formed.");
  }
  return parsed;
}

function isNativeWorkflow(workflow: WorkflowDefinition): workflow is NativeWorkflow {
  return typeof workflow === "object" && workflow !== null && "ir" in workflow;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
