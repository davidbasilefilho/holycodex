// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import { freezeDeep } from "./common.ts";
import { CoreError, type CoreResult, failure, inputError, success } from "./errors.ts";
import { decodeUnknown } from "./schema.ts";
import {
  PlanNameSchema,
  PlanSelectionSchema,
  ROLE_DEFINITIONS,
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
  const parsed = decodeUnknown(PlanSelectionSchema, input);
  if (Either.isLeft(parsed)) {
    return failure(inputError("plan selection", parsed.left));
  }
  return success(parsed.right);
}

function route(role: Role, task: TaskForRole<Role>, effort: Effort): RouteDefinition {
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

export const ROUTE_EFFORT_OVERRIDES = [
  {
    plan: "plus-low",
    rationale: "Preserve the approved plus-low route effort policy.",
    efforts: {
      "Explorer:lookup": "medium",
      "Explorer:trace": "high",
      "Librarian:lookup": "medium",
      "Librarian:research": "high",
      "Worker:mechanical": "high",
      "Worker:implementation": "high",
      "Worker:integration": "xhigh",
      "Worker:operations": "high",
      "Reviewer:plan": "high",
      "Reviewer:code": "xhigh",
      "Reviewer:artifact": "high",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
  {
    plan: "plus",
    rationale: "Preserve the approved plus route effort policy.",
    efforts: {
      "Explorer:lookup": "medium",
      "Explorer:trace": "high",
      "Librarian:lookup": "medium",
      "Librarian:research": "high",
      "Worker:mechanical": "high",
      "Worker:implementation": "xhigh",
      "Worker:integration": "xhigh",
      "Worker:operations": "high",
      "Reviewer:plan": "high",
      "Reviewer:code": "xhigh",
      "Reviewer:artifact": "high",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
  {
    plan: "plus-high",
    rationale: "Preserve the approved plus-high route effort policy.",
    efforts: {
      "Explorer:lookup": "medium",
      "Explorer:trace": "xhigh",
      "Librarian:lookup": "medium",
      "Librarian:research": "xhigh",
      "Worker:mechanical": "high",
      "Worker:implementation": "xhigh",
      "Worker:integration": "max",
      "Worker:operations": "xhigh",
      "Reviewer:plan": "xhigh",
      "Reviewer:code": "max",
      "Reviewer:artifact": "xhigh",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
  {
    plan: "pro-5x",
    rationale: "Preserve the approved pro-5x route effort policy.",
    efforts: {
      "Explorer:lookup": "high",
      "Explorer:trace": "xhigh",
      "Librarian:lookup": "high",
      "Librarian:research": "xhigh",
      "Worker:mechanical": "high",
      "Worker:implementation": "max",
      "Worker:integration": "max",
      "Worker:operations": "xhigh",
      "Reviewer:plan": "xhigh",
      "Reviewer:code": "max",
      "Reviewer:artifact": "xhigh",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
  {
    plan: "pro-20x",
    rationale: "Preserve the approved pro-20x route effort policy.",
    efforts: {
      "Explorer:lookup": "high",
      "Explorer:trace": "xhigh",
      "Librarian:lookup": "high",
      "Librarian:research": "max",
      "Worker:mechanical": "xhigh",
      "Worker:implementation": "max",
      "Worker:integration": "max",
      "Worker:operations": "xhigh",
      "Reviewer:plan": "max",
      "Reviewer:code": "max",
      "Reviewer:artifact": "max",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
] as const;
freezeDeep(ROUTE_EFFORT_OVERRIDES);

type SpecialistPlanName = Exclude<PlanName, "go">;
const effortOverridesByPlan = new Map<SpecialistPlanName, (typeof ROUTE_EFFORT_OVERRIDES)[number]>(
  ROUTE_EFFORT_OVERRIDES.map((override) => [override.plan, override] as const),
);

function routesForPlan(plan: SpecialistPlanName): readonly RouteDefinition[] {
  const override = effortOverridesByPlan.get(plan);
  if (override === undefined) {
    throw new CoreError("catalog_invalid", "A specialist plan has no route effort policy.", {
      plan,
    });
  }
  return ROLE_DEFINITIONS.flatMap((definition) =>
    definition.tasks.map((task) => {
      const key = `${definition.role}:${task.name}` as RouteKey;
      const effort = override.efforts[key];
      if (effort === undefined) {
        throw new CoreError("catalog_invalid", "A route effort policy is incomplete.", {
          plan,
          route: key,
        });
      }
      return route(definition.role, task.name, effort);
    }),
  );
}

function specialistPlan(
  input: Readonly<{
    readonly name: SpecialistPlanName;
    readonly root: PlanDefinition["root"];
  }>,
): PlanDefinition {
  return {
    ...input,
    specialistModel: "Luna",
    defaultServiceTier: "standard",
    routes: routesForPlan(input.name),
  };
}

const planDefinitions: PlanDefinition[] = [
  {
    name: "go",
    root: { model: "Terra", effort: "high" },
    specialistModel: "Luna",
    defaultServiceTier: "standard",
    routes: routesForPlan("plus-low"),
  },
  specialistPlan({
    name: "plus-low",
    root: { model: "Sol", effort: "low" },
  }),
  specialistPlan({
    name: "plus",
    root: { model: "Sol", effort: "medium" },
  }),
  specialistPlan({
    name: "plus-high",
    root: { model: "Sol", effort: "high" },
  }),
  specialistPlan({
    name: "pro-5x",
    root: { model: "Sol", effort: "high" },
  }),
  specialistPlan({
    name: "pro-20x",
    root: { model: "Sol", effort: "xhigh" },
  }),
];

function validateCatalog(definitions: readonly PlanDefinition[]): void {
  const expectedPlans: readonly PlanName[] = [
    "go",
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
      definition.name === "go"
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
    if (definition.specialistModel !== "Luna" || definition.defaultServiceTier !== "standard") {
      throw new CoreError("catalog_invalid", "A plan has an invalid specialist policy.", {
        plan: definition.name,
      });
    }
    if (definition.routes.length !== ROUTE_KEYS.length) {
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

  const goRoutes = definitions[0]?.routes;
  const plusLowRoutes = definitions[1]?.routes;
  if (
    !goRoutes ||
    !plusLowRoutes ||
    goRoutes.length !== plusLowRoutes.length ||
    goRoutes.some(
      (routeDefinition, index) =>
        routeDefinition.key !== plusLowRoutes[index]?.key ||
        routeDefinition.model !== plusLowRoutes[index]?.model ||
        routeDefinition.effort !== plusLowRoutes[index]?.effort,
    )
  ) {
    throw new CoreError("catalog_invalid", "go must use the plus-low specialist route matrix.");
  }

  const specialistPlans = definitions;
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
  const parsed = decodeUnknown(PlanNameSchema, input);
  if (Either.isLeft(parsed)) {
    return failure(
      new CoreError(
        "invalid_plan",
        "Unknown plan selection.",
        { field: "plan" },
        { cause: parsed.left },
      ),
    );
  }
  const definition = plansByName.get(parsed.right);
  if (!definition) {
    return failure(
      new CoreError("invalid_plan", "Unknown plan selection.", { plan: parsed.right }),
    );
  }
  return success(definition);
}

function parseRouteKey(input: unknown): CoreResult<RouteKey> {
  const parsedKey = decodeUnknown(RouteKeySchema, input);
  if (Either.isRight(parsedKey)) {
    return success(parsedKey.right);
  }

  const parsedRoleTask = decodeUnknown(RoleTaskSchema, input);
  if (Either.isRight(parsedRoleTask)) {
    const key = `${parsedRoleTask.right.role}:${parsedRoleTask.right.task}`;
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
        cause: parsedKey.left,
      },
    ),
  );
}

export function lookupRoute(planInput: unknown, routeInput: unknown): CoreResult<RouteDefinition> {
  const planResult = lookupPlan(planInput);
  if (!planResult.ok) {
    return planResult;
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
