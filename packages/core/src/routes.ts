// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import { freezeDeep } from "./common.ts";

export const PlanNameSchema = Schema.Literal(
  "Go",
  "plus-low",
  "plus",
  "plus-high",
  "pro-5x",
  "pro-20x",
);
export type PlanName = typeof PlanNameSchema.Type;

export const ServiceTierSchema = Schema.Literal("Standard", "Fast");
export type ServiceTier = typeof ServiceTierSchema.Type;

export const EffortSchema = Schema.Literal("low", "medium", "high", "xhigh", "max");
export type Effort = typeof EffortSchema.Type;

export const DelegationModeSchema = Schema.Literal("DIRECT", "SINGLE", "DYNAMIC_WORKFLOW");
export type DelegationMode = typeof DelegationModeSchema.Type;

const DigestSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const SkillReferenceSchema = Schema.String.pipe(Schema.pattern(/^\$[a-z][a-z0-9-]*$/u));
const SkillVersionSchema = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
);
export const RoleSkillProfileSchema = Schema.Struct({
  reference: SkillReferenceSchema,
  version: SkillVersionSchema,
  mode: Schema.Literal("lite", "full", "ultra"),
  digest: DigestSchema,
  instruction: Schema.String.pipe(Schema.minLength(1)),
});
export type RoleSkillProfile = typeof RoleSkillProfileSchema.Type;
export type RoleSkillProfileOrEmpty = RoleSkillProfile | null;

export const PONYTAIL_ROLE_SKILL = Object.freeze({
  reference: "$ponytail",
  version: "4.9.0",
  mode: "lite",
  digest: "1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2",
  instruction: "Use the literal $ponytail skill reference in lite mode.",
} as const satisfies RoleSkillProfile);

export const ROLE_DEFINITIONS = [
  {
    role: "Explorer",
    tasks: [
      { name: "lookup", instruction: "Locate the exact requested repository fact." },
      { name: "trace", instruction: "Trace the complete in-scope execution or reference path." },
    ],
    capability: "repository-read",
    authority: "Read only the assigned repository scope; Root owns decisions.",
    evidence: "Return exact paths, symbols, callers, tests, and constraints.",
    completion: "Account for every in-scope caller and constraint.",
    skills: [],
    skill_profile: null,
    permissions: { network: false, write: false, execute: false },
  },
  {
    role: "Librarian",
    tasks: [
      { name: "lookup", instruction: "Locate the exact requested authoritative external fact." },
      { name: "research", instruction: "Synthesize the assigned current sources with citations." },
    ],
    capability: "current-research",
    authority: "Research only the assigned current sources; Root owns decisions.",
    evidence: "Return sourced facts, dates, and explicit uncertainty.",
    completion: "Resolve the assigned external fact or report the exact evidence gap.",
    skills: ["context7-cli"],
    skill_profile: null,
    permissions: { network: true, write: false, execute: false },
  },
  {
    role: "Worker",
    tasks: [
      { name: "mechanical", instruction: "Apply only deterministic, already-decided edits." },
      { name: "implementation", instruction: "Implement and verify the bounded behavior seam." },
      { name: "integration", instruction: "Integrate the decided seams and verify them together." },
      {
        name: "operations",
        instruction: "Perform only the explicitly approved stateful operation.",
      },
    ],
    capability: "bounded-write",
    authority: "Change only the assigned seam; Root owns material choices.",
    evidence: "Return changed files, verification results, and remaining risk.",
    completion: "Finish the assigned seam with proportional proof or an exact blocker.",
    skills: ["programming"],
    skill_profile: PONYTAIL_ROLE_SKILL,
    permissions: { network: false, write: true, execute: true },
  },
  {
    role: "Reviewer",
    tasks: [
      { name: "plan", instruction: "Review the complete plan to a fixed point." },
      { name: "code", instruction: "Review and repair the implemented code to a fixed point." },
      {
        name: "artifact",
        instruction: "Review and repair the produced artifact to a fixed point.",
      },
    ],
    capability: "bounded-review",
    authority: "Inspect and repair only reviewer-owned defects; Root owns material choices.",
    evidence: "Return findings, repaired paths, verification, and residual risk.",
    completion: "Reach a fixed point or report each reproducible blocker.",
    skills: ["code-review"],
    skill_profile: PONYTAIL_ROLE_SKILL,
    permissions: { network: false, write: true, execute: true },
  },
] as const;
freezeDeep(ROLE_DEFINITIONS);

export type RoleDefinition = (typeof ROLE_DEFINITIONS)[number];
export type Role = RoleDefinition["role"];
export type TaskForRole<R extends Role> = Extract<
  RoleDefinition,
  { readonly role: R }
>["tasks"][number]["name"];
export type ExplorerTask = TaskForRole<"Explorer">;
export type LibrarianTask = TaskForRole<"Librarian">;
export type WorkerTask = TaskForRole<"Worker">;
export type ReviewerTask = TaskForRole<"Reviewer">;
export type TaskSlot = RoleDefinition["tasks"][number]["name"];
export type RoleTask = {
  readonly [R in Role]: { readonly role: R; readonly task: TaskForRole<R> };
}[Role];
export type RouteKey = RoleTask extends infer Pair
  ? Pair extends RoleTask
    ? `${Pair["role"]}:${Pair["task"]}`
    : never
  : never;
export type NativeAgentType = RoleTask extends infer Pair
  ? Pair extends RoleTask
    ? `${Pair["role"]}.${Pair["task"]}`
    : never
  : never;

const roleDefinitionsByName = new Map<Role, RoleDefinition>(
  ROLE_DEFINITIONS.map((definition) => [definition.role, definition]),
);
const roleNameSet = new Set<string>(ROLE_DEFINITIONS.map((definition) => definition.role));
const routeKeys = ROLE_DEFINITIONS.flatMap((definition) =>
  definition.tasks.map((task) => `${definition.role}:${task.name}`),
);
const routeKeySet = new Set<string>(routeKeys);
const nativeAgentTypes = routeKeys.map((key) => key.replace(":", "."));
const nativeAgentTypeSet = new Set(nativeAgentTypes);

function isRole(value: unknown): value is Role {
  return typeof value === "string" && roleNameSet.has(value);
}

function isRoleTask(value: unknown): value is RoleTask {
  if (typeof value !== "object" || value === null || !("role" in value) || !("task" in value)) {
    return false;
  }
  const role = value.role;
  const task = value.task;
  if (!isRole(role) || typeof task !== "string") {
    return false;
  }
  return (
    roleDefinitionsByName.get(role)?.tasks.some((candidate) => candidate.name === task) === true
  );
}

function isTaskForRole(role: Role, value: unknown): boolean {
  return (
    typeof value === "string" &&
    roleDefinitionsByName.get(role)?.tasks.some((candidate) => candidate.name === value) === true
  );
}

function isRouteKey(value: unknown): value is RouteKey {
  return typeof value === "string" && routeKeySet.has(value);
}

export const RoleSchema = Schema.declare(isRole);
export const ExplorerTaskSchema = Schema.declare((value: unknown): value is ExplorerTask =>
  isTaskForRole("Explorer", value),
);
export const LibrarianTaskSchema = Schema.declare((value: unknown): value is LibrarianTask =>
  isTaskForRole("Librarian", value),
);
export const WorkerTaskSchema = Schema.declare((value: unknown): value is WorkerTask =>
  isTaskForRole("Worker", value),
);
export const ReviewerTaskSchema = Schema.declare((value: unknown): value is ReviewerTask =>
  isTaskForRole("Reviewer", value),
);
export const RoleTaskSchema = Schema.declare(isRoleTask);
export const ROUTE_KEYS: readonly RouteKey[] = Object.freeze(
  routeKeys.filter((key): key is RouteKey => isRouteKey(key)),
);
export const RouteKeySchema = Schema.declare(isRouteKey);
export const NATIVE_AGENT_TYPES: readonly NativeAgentType[] = Object.freeze(
  nativeAgentTypes.filter((agentType): agentType is NativeAgentType =>
    nativeAgentTypeSet.has(agentType),
  ),
);
export const NativeAgentTypeSchema = Schema.declare(
  (value: unknown): value is NativeAgentType =>
    typeof value === "string" && nativeAgentTypeSet.has(value),
);

export function nativeAgentTypeFor(route: RoleTask): NativeAgentType {
  const value = `${route.role}.${route.task}`;
  if (!nativeAgentTypeSet.has(value)) throw new Error("Unknown native specialist agent type.");
  return value as NativeAgentType;
}

export function taskInstructionFor(route: RoleTask): string {
  const task = roleDefinitionsByName
    .get(route.role)
    ?.tasks.find((candidate) => candidate.name === route.task);
  if (task === undefined) throw new Error("Unknown specialist task policy.");
  return task.instruction;
}

export function lookupRoleDefinition(role: Role): RoleDefinition {
  const definition = roleDefinitionsByName.get(role);
  if (definition === undefined) {
    throw new Error("Unknown specialist role.");
  }
  return definition;
}

export interface PlanBudget {
  readonly costTarget: number;
  readonly costMax: number;
  readonly maxCalls: number;
  readonly maxConcurrency: number;
}

export interface RouteDefinition {
  readonly key: RouteKey;
  readonly role: Role;
  readonly task: TaskSlot;
  readonly model: "Luna";
  readonly effort: Effort;
}

export interface PlanDefinition {
  readonly name: PlanName;
  readonly root: {
    readonly model: "Terra" | "Sol";
    readonly effort: Effort;
  };
  readonly specialistModel: "Luna";
  readonly workflowEnabled: boolean;
  readonly defaultServiceTier: ServiceTier;
  readonly budget: PlanBudget | null;
  readonly routes: readonly RouteDefinition[];
}

export const PlanSelectionSchema = Schema.Struct({
  plan: PlanNameSchema,
  service_tier: Schema.optional(ServiceTierSchema),
});
export type PlanSelection = typeof PlanSelectionSchema.Type;
