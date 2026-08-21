// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

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

export const RoleSchema = Schema.Literal("Explorer", "Librarian", "Worker", "Reviewer");
export type Role = typeof RoleSchema.Type;

export const ExplorerTaskSchema = Schema.Literal("lookup", "trace");
export type ExplorerTask = typeof ExplorerTaskSchema.Type;

export const LibrarianTaskSchema = Schema.Literal("lookup", "research");
export type LibrarianTask = typeof LibrarianTaskSchema.Type;

export const WorkerTaskSchema = Schema.Literal(
  "mechanical",
  "implementation",
  "integration",
  "operations",
);
export type WorkerTask = typeof WorkerTaskSchema.Type;

export const ReviewerTaskSchema = Schema.Literal("plan", "code", "artifact");
export type ReviewerTask = typeof ReviewerTaskSchema.Type;

export type TaskSlot = ExplorerTask | LibrarianTask | WorkerTask | ReviewerTask;
export type TaskForRole<R extends Role> = R extends "Explorer"
  ? ExplorerTask
  : R extends "Librarian"
    ? LibrarianTask
    : R extends "Worker"
      ? WorkerTask
      : ReviewerTask;

const ExplorerRoleTaskSchema = Schema.Struct({
  role: Schema.Literal("Explorer"),
  task: ExplorerTaskSchema,
});
const LibrarianRoleTaskSchema = Schema.Struct({
  role: Schema.Literal("Librarian"),
  task: LibrarianTaskSchema,
});
const WorkerRoleTaskSchema = Schema.Struct({
  role: Schema.Literal("Worker"),
  task: WorkerTaskSchema,
});
const ReviewerRoleTaskSchema = Schema.Struct({
  role: Schema.Literal("Reviewer"),
  task: ReviewerTaskSchema,
});
export const RoleTaskSchema = Schema.Union(
  ExplorerRoleTaskSchema,
  LibrarianRoleTaskSchema,
  WorkerRoleTaskSchema,
  ReviewerRoleTaskSchema,
);
export type RoleTask = typeof RoleTaskSchema.Type;

export const ROUTE_KEYS = Object.freeze([
  "Explorer:lookup",
  "Explorer:trace",
  "Librarian:lookup",
  "Librarian:research",
  "Worker:mechanical",
  "Worker:implementation",
  "Worker:integration",
  "Worker:operations",
  "Reviewer:plan",
  "Reviewer:code",
  "Reviewer:artifact",
] as const);
export type RouteKey = (typeof ROUTE_KEYS)[number];

export const RouteKeySchema = Schema.Literal(
  "Explorer:lookup",
  "Explorer:trace",
  "Librarian:lookup",
  "Librarian:research",
  "Worker:mechanical",
  "Worker:implementation",
  "Worker:integration",
  "Worker:operations",
  "Reviewer:plan",
  "Reviewer:code",
  "Reviewer:artifact",
);

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
