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

export const ROLE_DEFINITIONS = [
  {
    role: "Explorer",
    tasks: ["lookup", "trace"],
    capability: "repository-read",
    authority: "Read only the assigned repository scope; Root owns decisions.",
    evidence: "Return exact paths, symbols, callers, tests, and constraints.",
    completion: "Account for every in-scope caller and constraint.",
    skills: [],
    ponytail: false,
    permissions: { network: false, write: false, execute: false },
  },
  {
    role: "Librarian",
    tasks: ["lookup", "research"],
    capability: "current-research",
    authority: "Research only the assigned current sources; Root owns decisions.",
    evidence: "Return sourced facts, dates, and explicit uncertainty.",
    completion: "Resolve the assigned external fact or report the exact evidence gap.",
    skills: ["context7-cli"],
    ponytail: false,
    permissions: { network: true, write: false, execute: false },
  },
  {
    role: "Worker",
    tasks: ["mechanical", "implementation", "integration", "operations"],
    capability: "bounded-write",
    authority: "Change only the assigned seam; Root owns material choices.",
    evidence: "Return changed files, verification results, and remaining risk.",
    completion: "Finish the assigned seam with proportional proof or an exact blocker.",
    skills: ["programming"],
    ponytail: true,
    permissions: { network: false, write: true, execute: true },
  },
  {
    role: "Reviewer",
    tasks: ["plan", "code", "artifact"],
    capability: "bounded-review",
    authority: "Inspect and repair only reviewer-owned defects; Root owns material choices.",
    evidence: "Return findings, repaired paths, verification, and residual risk.",
    completion: "Reach a fixed point or report each reproducible blocker.",
    skills: ["code-review"],
    ponytail: true,
    permissions: { network: false, write: true, execute: true },
  },
] as const;
freezeDeep(ROLE_DEFINITIONS);

type RoleDefinition = (typeof ROLE_DEFINITIONS)[number];
export type Role = RoleDefinition["role"];
export type TaskForRole<R extends Role> = Extract<
  RoleDefinition,
  { readonly role: R }
>["tasks"][number];
export type ExplorerTask = TaskForRole<"Explorer">;
export type LibrarianTask = TaskForRole<"Librarian">;
export type WorkerTask = TaskForRole<"Worker">;
export type ReviewerTask = TaskForRole<"Reviewer">;
export type TaskSlot = RoleDefinition["tasks"][number];
export type RoleTask = {
  readonly [R in Role]: { readonly role: R; readonly task: TaskForRole<R> };
}[Role];
export type RouteKey = RoleTask extends infer Pair
  ? Pair extends RoleTask
    ? `${Pair["role"]}:${Pair["task"]}`
    : never
  : never;

const roleDefinitionsByName = new Map<Role, RoleDefinition>(
  ROLE_DEFINITIONS.map((definition) => [definition.role, definition]),
);
const roleNameSet = new Set<string>(ROLE_DEFINITIONS.map((definition) => definition.role));
const routeKeys = ROLE_DEFINITIONS.flatMap((definition) =>
  definition.tasks.map((task) => `${definition.role}:${task}`),
);
const routeKeySet = new Set<string>(routeKeys);

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
  return roleDefinitionsByName.get(role)?.tasks.some((candidate) => candidate === task) === true;
}

function isRouteKey(value: unknown): value is RouteKey {
  return typeof value === "string" && routeKeySet.has(value);
}

export const RoleSchema = Schema.declare(isRole);
export const ExplorerTaskSchema = Schema.Literal("lookup", "trace");
export const LibrarianTaskSchema = Schema.Literal("lookup", "research");
export const WorkerTaskSchema = Schema.Literal(
  "mechanical",
  "implementation",
  "integration",
  "operations",
);
export const ReviewerTaskSchema = Schema.Literal("plan", "code", "artifact");
export const RoleTaskSchema = Schema.declare(isRoleTask);
export const ROUTE_KEYS: readonly RouteKey[] = Object.freeze(
  routeKeys.filter((key): key is RouteKey => isRouteKey(key)),
);
export const RouteKeySchema = Schema.declare(isRouteKey);

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
