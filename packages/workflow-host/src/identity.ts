// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  parseSpecialistOutcome,
  RouteKeySchema,
  STATE_SCHEMA_EPOCH,
  type JsonObject,
  type JsonValue,
  type PlanDefinition,
  type RouteKey,
  type ServiceTier,
  type SpecialistOutcome,
} from "@holycodex/core";
import {
  IdentityComponentsSchema,
  JsonObjectSchema,
  JsonValueSchema,
  ProjectTrustRefSchema,
  SchemaEpochsSchema,
  WORKFLOW_HOST_SCHEMA_EPOCH,
  decodeHostSchema,
  type IdentityComponents,
  type ProjectTrustRef,
  type SchemaEpochs,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import type { HostContext, ProjectTrustInput } from "./types.ts";

export const ZERO_DIGEST = "0".repeat(64);
export const DEFAULT_PROFILE = "default";
export const DEFAULT_ROUTE: RouteKey = "Worker:implementation";
export const MAX_PENDING_TEXT = 4096;
export const MAX_CHECKPOINT_ITEMS = 64;
export const MAX_BOUNDED_JSON_BYTES = 256 * 1024;

export function now(): string {
  return new Date().toISOString();
}

export function safeText(value: string, limit = 512): string {
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
  return output.replace(/\s+/gu, " ").trim().slice(0, limit);
}

export function safeTextArray(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new WorkflowHostError("invalid_input", "A bounded text list is invalid.");
  }
  return values.slice(0, MAX_CHECKPOINT_ITEMS).map((value) => safeText(value));
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
    throw new WorkflowHostError("invalid_input", `The ${field} must be bounded JSON.`);
  }
  if (new TextEncoder().encode(canonicalJson(parsed)).byteLength > MAX_BOUNDED_JSON_BYTES) {
    throw new WorkflowHostError("invalid_input", `The ${field} exceeds the host size bound.`);
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

export function sanitizeOutcome(value: SpecialistOutcome): SpecialistOutcome {
  const parsed = parseSpecialistOutcome(value);
  if (!parsed.ok) {
    throw new WorkflowHostError("specialist_invalid", "The specialist outcome is invalid.");
  }
  return {
    blocked: parsed.value.blocked,
    changed_files: safeTextArray(parsed.value.changed_files),
    confidence: Number.isFinite(parsed.value.confidence)
      ? Math.max(0, Math.min(1, parsed.value.confidence))
      : 0,
    context_owner:
      parsed.value.context_owner === null ? null : safeText(parsed.value.context_owner),
    material_findings: safeTextArray(parsed.value.material_findings),
    needs_more_context: parsed.value.needs_more_context,
    needs_root_decision: parsed.value.needs_root_decision,
    needs_verification: parsed.value.needs_verification,
    relevant_files: safeTextArray(parsed.value.relevant_files),
    remaining_risk: safeTextArray(parsed.value.remaining_risk),
    reuse_recommended: parsed.value.reuse_recommended,
    status: parsed.value.status,
    suggested_followup:
      parsed.value.suggested_followup === null ? null : safeText(parsed.value.suggested_followup),
    suggested_luna_effort: parsed.value.suggested_luna_effort,
    suggested_specialist: parsed.value.suggested_specialist,
    verification: safeTextArray(parsed.value.verification),
    verification_passed: parsed.value.verification_passed,
  };
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

export async function buildIdentity(
  input: Readonly<{
    readonly source: string;
    readonly args: JsonValue;
    readonly plan: PlanDefinition;
    readonly route: RouteKey;
    readonly serviceTier: ServiceTier;
    readonly role: IdentityComponents["role"];
    readonly context: HostContext;
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
  };
  const parsed = decodeHostSchema(IdentityComponentsSchema, identity);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", "The run identity could not be formed.");
  }
  return parsed;
}
