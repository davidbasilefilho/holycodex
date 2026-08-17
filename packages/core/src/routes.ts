// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";

export const PlanNameSchema = type(
  "'Go' | 'plus-low' | 'plus' | 'plus-high' | 'pro-5x' | 'pro-20x'",
);
export type PlanName = typeof PlanNameSchema.infer;

export const ServiceTierSchema = type("'Standard' | 'Fast'");
export type ServiceTier = typeof ServiceTierSchema.infer;

export const EffortSchema = type("'low' | 'medium' | 'high' | 'xhigh' | 'max'");
export type Effort = typeof EffortSchema.infer;

export const RoleSchema = type("'Explorer' | 'Librarian' | 'Worker' | 'Reviewer'");
export type Role = typeof RoleSchema.infer;

export const ExplorerTaskSchema = type("'lookup' | 'trace'");
export type ExplorerTask = typeof ExplorerTaskSchema.infer;

export const LibrarianTaskSchema = type("'lookup' | 'research'");
export type LibrarianTask = typeof LibrarianTaskSchema.infer;

export const WorkerTaskSchema = type(
  "'mechanical' | 'implementation' | 'integration' | 'operations'",
);
export type WorkerTask = typeof WorkerTaskSchema.infer;

export const ReviewerTaskSchema = type("'plan' | 'code' | 'artifact'");
export type ReviewerTask = typeof ReviewerTaskSchema.infer;

export type TaskSlot = ExplorerTask | LibrarianTask | WorkerTask | ReviewerTask;
export type TaskForRole<R extends Role> = R extends "Explorer"
  ? ExplorerTask
  : R extends "Librarian"
    ? LibrarianTask
    : R extends "Worker"
      ? WorkerTask
      : ReviewerTask;

export type RoleTask =
  | { readonly role: "Explorer"; readonly task: ExplorerTask }
  | { readonly role: "Librarian"; readonly task: LibrarianTask }
  | { readonly role: "Worker"; readonly task: WorkerTask }
  | { readonly role: "Reviewer"; readonly task: ReviewerTask };

const ExplorerRoleTaskSchema = type({
  "+": "reject",
  role: "'Explorer'",
  task: ExplorerTaskSchema,
});
const LibrarianRoleTaskSchema = type({
  "+": "reject",
  role: "'Librarian'",
  task: LibrarianTaskSchema,
});
const WorkerRoleTaskSchema = type({
  "+": "reject",
  role: "'Worker'",
  task: WorkerTaskSchema,
});
const ReviewerRoleTaskSchema = type({
  "+": "reject",
  role: "'Reviewer'",
  task: ReviewerTaskSchema,
});
export const RoleTaskSchema = ExplorerRoleTaskSchema.or(LibrarianRoleTaskSchema)
  .or(WorkerRoleTaskSchema)
  .or(ReviewerRoleTaskSchema);

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

export const RouteKeySchema = type(
  "'Explorer:lookup' | 'Explorer:trace' | 'Librarian:lookup' | 'Librarian:research' | 'Worker:mechanical' | 'Worker:implementation' | 'Worker:integration' | 'Worker:operations' | 'Reviewer:plan' | 'Reviewer:code' | 'Reviewer:artifact'",
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

export const PlanSelectionSchema = type({
  "+": "reject",
  plan: PlanNameSchema,
  "service_tier?": ServiceTierSchema,
});
export type PlanSelection = typeof PlanSelectionSchema.infer;
