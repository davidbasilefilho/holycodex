// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import { freezeDeep } from "./common.ts";

export const PlanNameSchema = Schema.Literal(
  "go",
  "plus-low",
  "plus",
  "plus-high",
  "pro-5x",
  "pro-20x",
);
export type PlanName = typeof PlanNameSchema.Type;

/** Historical plan spelling accepted only while migrating persisted state. */
export const LegacyPlanNameSchema = Schema.Literal("Go");
export type LegacyPlanName = typeof LegacyPlanNameSchema.Type;
export const PlanNameMigrationSchema = Schema.Union(PlanNameSchema, LegacyPlanNameSchema);
export type PlanNameMigrationInput = typeof PlanNameMigrationSchema.Type;

export function migratePlanName(input: PlanNameMigrationInput): PlanName {
  return input === "Go" ? "go" : input;
}

export const ServiceTierSchema = Schema.Literal("standard", "fast", "fast-all");
export type ServiceTier = typeof ServiceTierSchema.Type;

export const EffortSchema = Schema.Literal("low", "medium", "high", "xhigh", "max");
export type Effort = typeof EffortSchema.Type;

export const ROLE_DEFINITIONS = [
  {
    role: "Explorer",
    tasks: [
      {
        name: "lookup",
        description:
          "Use when Root needs one exact repository fact; locate it and return the exact path, symbol, or value.",
        instruction: "Locate the exact requested repository fact.",
      },
      {
        name: "trace",
        description:
          "Use when Root needs a complete in-scope execution or reference path; trace every relevant caller and constraint, then return the path and evidence.",
        instruction: "Trace the complete in-scope execution or reference path.",
      },
    ],
    capability: "repository-read",
    authority: "Read only the assigned repository scope; Root owns decisions.",
    evidence: "Return exact paths, symbols, callers, tests, and constraints.",
    completion: "Account for every in-scope caller and constraint.",
    permissions: { network: false, write: false, execute: false },
  },
  {
    role: "Librarian",
    tasks: [
      {
        name: "lookup",
        description:
          "Use when Root needs one exact current external fact; locate it in the assigned authoritative source and return the citation.",
        instruction: "Locate the exact requested authoritative external fact.",
      },
      {
        name: "research",
        description:
          "Use when Root needs a sourced current synthesis; combine the assigned authoritative sources with citations and return the evidence and uncertainty.",
        instruction: "Synthesize the assigned current sources with citations.",
      },
    ],
    capability: "current-research",
    authority: "Research only the assigned current sources; Root owns decisions.",
    evidence: "Return sourced facts, dates, and explicit uncertainty.",
    completion: "Resolve the assigned external fact or report the exact evidence gap.",
    permissions: { network: true, write: false, execute: false },
  },
  {
    role: "Worker",
    tasks: [
      {
        name: "mechanical",
        description:
          "Use when Root has decided deterministic edits; apply only those edits, verify the result, and return changed paths and evidence.",
        instruction: "Apply only deterministic, already-decided edits.",
      },
      {
        name: "implementation",
        description:
          "Use when Root has decided a bounded behavior seam; implement and verify that seam, then return changed paths and evidence.",
        instruction: "Implement and verify the bounded behavior seam.",
      },
      {
        name: "integration",
        description:
          "Use when Root has decided seams that must be combined; integrate and verify them together, then return the result and residual risk.",
        instruction: "Integrate the decided seams and verify them together.",
      },
      {
        name: "operations",
        description:
          "Use after Root approves an exact ref or SHA; observe required CI and release state to terminal evidence and return it, never treating pending as success.",
        instruction:
          "After Root approves an exact ref or SHA, observe required CI and release state through terminal evidence; pending or running state is never success.",
      },
    ],
    capability: "bounded-write",
    authority: "Change only the assigned seam; Root owns material choices.",
    evidence: "Return changed files, verification results, and remaining risk.",
    completion: "Finish the assigned seam with proportional proof or an exact blocker.",
    permissions: { network: false, write: true, execute: true },
  },
  {
    role: "Reviewer",
    tasks: [
      {
        name: "plan",
        description:
          "Use when Root needs a complete plan adversarially checked; review it to a fixed point and return findings, proof, and residual risk.",
        instruction: "Review the complete plan to a fixed point.",
      },
      {
        name: "code",
        description:
          "Use when Root needs implemented code adversarially checked; review and repair it to a fixed point, returning findings, proof, and residual risk.",
        instruction: "Review and repair the implemented code to a fixed point.",
      },
      {
        name: "artifact",
        description:
          "Use when Root needs a produced artifact inspected; review and repair it to a fixed point, returning findings, proof, and residual risk.",
        instruction: "Review and repair the produced artifact to a fixed point.",
      },
    ],
    capability: "bounded-review",
    authority: "Inspect and repair only reviewer-owned defects; Root owns material choices.",
    evidence: "Return findings, repaired paths, verification, and residual risk.",
    completion: "Reach a fixed point or report each reproducible blocker.",
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

export function taskDescriptionFor(route: RoleTask): string {
  const task = roleDefinitionsByName
    .get(route.role)
    ?.tasks.find((candidate) => candidate.name === route.task);
  if (task === undefined) throw new Error("Unknown specialist task policy.");
  return task.description;
}

export function lookupRoleDefinition(role: Role): RoleDefinition {
  const definition = roleDefinitionsByName.get(role);
  if (definition === undefined) {
    throw new Error("Unknown specialist role.");
  }
  return definition;
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
  readonly defaultServiceTier: ServiceTier;
  readonly routes: readonly RouteDefinition[];
}

export const PlanSelectionSchema = Schema.Struct({
  plan: PlanNameSchema,
  service_tier: Schema.optional(ServiceTierSchema),
});
export type PlanSelection = typeof PlanSelectionSchema.Type;
