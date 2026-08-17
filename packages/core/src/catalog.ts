// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { freezeDeep } from "./common.ts";
import { CoreError, type CoreResult, failure, inputError, success } from "./errors.ts";
import {
  PlanNameSchema,
  PlanSelectionSchema,
  RoleTaskSchema,
  ROUTE_KEYS,
  RouteKeySchema,
  type Effort,
  type PlanDefinition,
  type PlanName,
  type PlanSelection,
  type Role,
  type RouteDefinition,
  type RouteKey,
  type ServiceTier,
  type TaskForRole,
} from "./routes.ts";

export function parsePlanSelection(input: unknown): CoreResult<PlanSelection> {
  const parsed = PlanSelectionSchema(input);
  if (parsed instanceof type.errors) {
    return failure(inputError("plan selection", parsed));
  }
  return success(parsed);
}

function route<R extends Role>(role: R, task: TaskForRole<R>, effort: Effort): RouteDefinition {
  return {
    key: `${role}:${task}` as RouteKey,
    role,
    task,
    model: "Luna",
    effort,
  };
}

const routeKeys = new Set<RouteKey>(ROUTE_KEYS);
const effortRank: Readonly<Record<Effort, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

const planDefinitions: PlanDefinition[] = [
  {
    name: "Go",
    root: { model: "Terra", effort: "high" },
    specialistModel: "Luna",
    workflowEnabled: false,
    defaultServiceTier: "Standard",
    budget: null,
    routes: [],
  },
  {
    name: "plus-low",
    root: { model: "Sol", effort: "low" },
    specialistModel: "Luna",
    workflowEnabled: true,
    defaultServiceTier: "Standard",
    budget: { costTarget: 1.0, costMax: 1.5, maxCalls: 10, maxConcurrency: 3 },
    routes: [
      route("Explorer", "lookup", "low"),
      route("Explorer", "trace", "medium"),
      route("Librarian", "lookup", "low"),
      route("Librarian", "research", "medium"),
      route("Worker", "mechanical", "medium"),
      route("Worker", "implementation", "high"),
      route("Worker", "integration", "high"),
      route("Worker", "operations", "medium"),
      route("Reviewer", "plan", "medium"),
      route("Reviewer", "code", "high"),
      route("Reviewer", "artifact", "medium"),
    ],
  },
  {
    name: "plus",
    root: { model: "Sol", effort: "medium" },
    specialistModel: "Luna",
    workflowEnabled: true,
    defaultServiceTier: "Standard",
    budget: { costTarget: 1.6, costMax: 2.5, maxCalls: 16, maxConcurrency: 3 },
    routes: [
      route("Explorer", "lookup", "medium"),
      route("Explorer", "trace", "high"),
      route("Librarian", "lookup", "medium"),
      route("Librarian", "research", "high"),
      route("Worker", "mechanical", "high"),
      route("Worker", "implementation", "xhigh"),
      route("Worker", "integration", "xhigh"),
      route("Worker", "operations", "high"),
      route("Reviewer", "plan", "high"),
      route("Reviewer", "code", "xhigh"),
      route("Reviewer", "artifact", "high"),
    ],
  },
  {
    name: "plus-high",
    root: { model: "Sol", effort: "high" },
    specialistModel: "Luna",
    workflowEnabled: true,
    defaultServiceTier: "Standard",
    budget: { costTarget: 3.0, costMax: 4.5, maxCalls: 24, maxConcurrency: 4 },
    routes: [
      route("Explorer", "lookup", "high"),
      route("Explorer", "trace", "xhigh"),
      route("Librarian", "lookup", "high"),
      route("Librarian", "research", "xhigh"),
      route("Worker", "mechanical", "high"),
      route("Worker", "implementation", "max"),
      route("Worker", "integration", "max"),
      route("Worker", "operations", "high"),
      route("Reviewer", "plan", "xhigh"),
      route("Reviewer", "code", "max"),
      route("Reviewer", "artifact", "xhigh"),
    ],
  },
  {
    name: "pro-5x",
    root: { model: "Sol", effort: "high" },
    specialistModel: "Luna",
    workflowEnabled: true,
    defaultServiceTier: "Standard",
    budget: { costTarget: 5.0, costMax: 7.5, maxCalls: 40, maxConcurrency: 6 },
    routes: [
      route("Explorer", "lookup", "high"),
      route("Explorer", "trace", "xhigh"),
      route("Librarian", "lookup", "high"),
      route("Librarian", "research", "xhigh"),
      route("Worker", "mechanical", "high"),
      route("Worker", "implementation", "max"),
      route("Worker", "integration", "max"),
      route("Worker", "operations", "high"),
      route("Reviewer", "plan", "xhigh"),
      route("Reviewer", "code", "max"),
      route("Reviewer", "artifact", "xhigh"),
    ],
  },
  {
    name: "pro-20x",
    root: { model: "Sol", effort: "xhigh" },
    specialistModel: "Luna",
    workflowEnabled: true,
    defaultServiceTier: "Standard",
    budget: { costTarget: 12.0, costMax: 20.0, maxCalls: 64, maxConcurrency: 8 },
    routes: [
      route("Explorer", "lookup", "high"),
      route("Explorer", "trace", "max"),
      route("Librarian", "lookup", "high"),
      route("Librarian", "research", "max"),
      route("Worker", "mechanical", "xhigh"),
      route("Worker", "implementation", "max"),
      route("Worker", "integration", "max"),
      route("Worker", "operations", "xhigh"),
      route("Reviewer", "plan", "max"),
      route("Reviewer", "code", "max"),
      route("Reviewer", "artifact", "max"),
    ],
  },
];

function validateCatalog(definitions: readonly PlanDefinition[]): void {
  const expectedPlans: readonly PlanName[] = [
    "Go",
    "plus-low",
    "plus",
    "plus-high",
    "pro-5x",
    "pro-20x",
  ];
  if (definitions.length !== expectedPlans.length) {
    throw new CoreError("catalog_invalid", "The plan catalog has an invalid size.");
  }

  for (let index = 0; index < expectedPlans.length; index += 1) {
    const definition = definitions[index];
    const expectedPlan = expectedPlans[index];
    if (!definition || definition.name !== expectedPlan) {
      throw new CoreError("catalog_invalid", "The plan catalog order is invalid.", { index });
    }
    const expectedRoot =
      definition.name === "Go"
        ? { model: "Terra", effort: "high" }
        : definition.name === "plus-low"
          ? { model: "Sol", effort: "low" }
          : definition.name === "plus"
            ? { model: "Sol", effort: "medium" }
            : definition.name === "pro-20x"
              ? { model: "Sol", effort: "xhigh" }
              : { model: "Sol", effort: "high" };
    if (
      definition.root.model !== expectedRoot.model ||
      definition.root.effort !== expectedRoot.effort
    ) {
      throw new CoreError("catalog_invalid", "A plan has an invalid Root route.", {
        plan: definition.name,
      });
    }
    if (definition.specialistModel !== "Luna" || definition.defaultServiceTier !== "Standard") {
      throw new CoreError("catalog_invalid", "A plan has an invalid specialist policy.", {
        plan: definition.name,
      });
    }
    if (definition.name === "Go") {
      if (
        definition.workflowEnabled ||
        definition.budget !== null ||
        definition.routes.length !== 0
      ) {
        throw new CoreError("catalog_invalid", "Go must disable specialist workflows.");
      }
      continue;
    }
    if (
      !definition.workflowEnabled ||
      definition.budget === null ||
      definition.routes.length !== ROUTE_KEYS.length
    ) {
      throw new CoreError("catalog_invalid", "A specialist plan is incomplete.", {
        plan: definition.name,
      });
    }
    const seenRoutes = new Set<RouteKey>();
    for (const routeDefinition of definition.routes) {
      if (
        seenRoutes.has(routeDefinition.key) ||
        !routeKeys.has(routeDefinition.key) ||
        routeDefinition.model !== "Luna" ||
        `${routeDefinition.role}:${routeDefinition.task}` !== routeDefinition.key
      ) {
        throw new CoreError("catalog_invalid", "A plan contains an invalid route.", {
          plan: definition.name,
        });
      }
      seenRoutes.add(routeDefinition.key);
    }
    if (seenRoutes.size !== ROUTE_KEYS.length) {
      throw new CoreError("catalog_invalid", "A plan is missing a specialist route.", {
        plan: definition.name,
      });
    }
  }

  const specialistPlans = definitions.slice(1);
  for (let routeIndex = 0; routeIndex < ROUTE_KEYS.length; routeIndex += 1) {
    let previousRank = -1;
    for (const definition of specialistPlans) {
      const routeDefinition = definition.routes[routeIndex];
      if (!routeDefinition || effortRank[routeDefinition.effort] < previousRank) {
        throw new CoreError("catalog_invalid", "Plan route effort is not monotonic.", {
          route: ROUTE_KEYS[routeIndex] ?? "unknown",
        });
      }
      previousRank = effortRank[routeDefinition.effort];
    }
  }
}

validateCatalog(planDefinitions);
freezeDeep(planDefinitions);
export const PLAN_CATALOG: readonly PlanDefinition[] = planDefinitions;

const plansByName = new Map<PlanName, PlanDefinition>();
const routesByPlan = new Map<PlanName, ReadonlyMap<RouteKey, RouteDefinition>>();
for (const definition of PLAN_CATALOG) {
  plansByName.set(definition.name, definition);
  const routes = new Map<RouteKey, RouteDefinition>();
  for (const routeDefinition of definition.routes) {
    routes.set(routeDefinition.key, routeDefinition);
  }
  routesByPlan.set(definition.name, routes);
}

export function lookupPlan(input: unknown): CoreResult<PlanDefinition> {
  const parsed = PlanNameSchema(input);
  if (parsed instanceof type.errors) {
    return failure(
      new CoreError(
        "invalid_plan",
        "Unknown plan selection.",
        { field: "plan" },
        { cause: parsed },
      ),
    );
  }
  const definition = plansByName.get(parsed);
  if (!definition) {
    return failure(new CoreError("invalid_plan", "Unknown plan selection.", { plan: parsed }));
  }
  return success(definition);
}

function parseRouteKey(input: unknown): CoreResult<RouteKey> {
  const parsedKey = RouteKeySchema(input);
  if (!(parsedKey instanceof type.errors)) {
    return success(parsedKey);
  }

  const parsedRoleTask = RoleTaskSchema(input);
  if (!(parsedRoleTask instanceof type.errors)) {
    const key = `${parsedRoleTask.role}:${parsedRoleTask.task}`;
    if (routeKeys.has(key as RouteKey)) {
      return success(key as RouteKey);
    }
  }
  return failure(
    new CoreError(
      "invalid_route",
      "Unknown specialist route.",
      { field: "route" },
      {
        cause: parsedKey,
      },
    ),
  );
}

export function lookupRoute(planInput: unknown, routeInput: unknown): CoreResult<RouteDefinition> {
  const planResult = lookupPlan(planInput);
  if (!planResult.ok) {
    return planResult;
  }

  if (!planResult.value.workflowEnabled) {
    return failure(
      new CoreError("route_unavailable", "The selected plan disables specialist workflows.", {
        plan: planResult.value.name,
      }),
    );
  }

  const routeResult = parseRouteKey(routeInput);
  if (!routeResult.ok) {
    return routeResult;
  }
  const routeDefinition = routesByPlan.get(planResult.value.name)?.get(routeResult.value);
  if (!routeDefinition) {
    return failure(
      new CoreError("invalid_route", "The route is not available for the selected plan.", {
        plan: planResult.value.name,
        route: routeResult.value,
      }),
    );
  }
  return success(routeDefinition);
}

export function resolvePlanSelection(input: unknown): CoreResult<{
  readonly plan: PlanDefinition;
  readonly serviceTier: ServiceTier;
}> {
  const selection = parsePlanSelection(input);
  if (!selection.ok) {
    return selection;
  }
  const plan = lookupPlan(selection.value.plan);
  if (!plan.ok) {
    return plan;
  }
  return success({
    plan: plan.value,
    serviceTier: selection.value.service_tier ?? plan.value.defaultServiceTier,
  });
}
