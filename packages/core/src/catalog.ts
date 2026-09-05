// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";

import { freezeDeep } from "./common.ts";
import { CoreError, type CoreResult, failure, inputError, success } from "./errors.ts";
import {
  ProfileNameSchema,
  ProfileSelectionSchema,
  ROLE_DEFINITIONS,
  RoleTaskSchema,
  ROUTE_KEYS,
  RouteKeySchema,
  type Effort,
  type ProfileDefinition,
  type ProfileName,
  type ProfileSelection,
  type Role,
  type RouteDefinition,
  type RouteKey,
  type ServiceTier,
  type TaskForRole,
} from "./routes.ts";
import { decodeUnknown } from "./schema.ts";

export const ASTRA_MODEL_ID = "gpt-6-astra" as const;
export const LUNA_MODEL_ID = "gpt-5.6-luna" as const;

/** Decode the canonical product profile selection used by routing. */
export function parseProfileSelection(input: unknown): CoreResult<ProfileSelection> {
  const parsed = decodeUnknown(ProfileSelectionSchema, input);
  if (Either.isLeft(parsed)) return failure(inputError("profile selection", parsed.left));
  return success(parsed.right);
}

function route(role: Role, task: TaskForRole<Role>, effort: Effort): RouteDefinition {
  return {
    key: `${role}:${task}` as RouteKey,
    role,
    task,
    model: LUNA_MODEL_ID,
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

/** Single source of truth for the specialist effort matrix for live profiles. */
export const ROUTE_EFFORT_OVERRIDES = [
  {
    profile: "low",
    rationale: "The low profile keeps bounded specialist work economical.",
    efforts: {
      "Explorer:lookup": "medium",
      "Explorer:trace": "high",
      "Librarian:lookup": "medium",
      "Librarian:research": "high",
      "Worker:mechanical": "high",
      "Worker:implementation": "high",
      "Worker:integration": "max",
      "Worker:operations": "high",
      "Reviewer:plan": "high",
      "Reviewer:code": "max",
      "Reviewer:artifact": "high",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
  {
    profile: "default",
    rationale: "The default profile is the recommended balanced route.",
    efforts: {
      "Explorer:lookup": "medium",
      "Explorer:trace": "xhigh",
      "Librarian:lookup": "medium",
      "Librarian:research": "xhigh",
      "Worker:mechanical": "high",
      "Worker:implementation": "xhigh",
      "Worker:integration": "max",
      "Worker:operations": "high",
      "Reviewer:plan": "xhigh",
      "Reviewer:code": "max",
      "Reviewer:artifact": "xhigh",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
  {
    profile: "high",
    rationale: "The high profile maximizes specialist reasoning where specified.",
    efforts: {
      "Explorer:lookup": "medium",
      "Explorer:trace": "max",
      "Librarian:lookup": "medium",
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

const effortOverridesByProfile = new Map<ProfileName, (typeof ROUTE_EFFORT_OVERRIDES)[number]>(
  ROUTE_EFFORT_OVERRIDES.map((override) => [override.profile, override] as const),
);

function routesForProfile(profile: ProfileName): readonly RouteDefinition[] {
  const override = effortOverridesByProfile.get(profile);
  if (override === undefined) {
    throw new CoreError("catalog_invalid", "A profile has no route effort policy.", { profile });
  }
  return ROLE_DEFINITIONS.flatMap((definition) =>
    definition.tasks.map((task) => {
      const key = `${definition.role}:${task.name}` as RouteKey;
      const effort = override.efforts[key];
      if (effort === undefined) {
        throw new CoreError("catalog_invalid", "A route effort policy is incomplete.", {
          profile,
          route: key,
        });
      }
      return route(definition.role, task.name, effort);
    }),
  );
}

function createProfile(
  input: Readonly<{ readonly name: ProfileName; readonly effort: Effort }>,
): ProfileDefinition {
  return {
    name: input.name,
    root: { model: "gpt-6-astra", effort: input.effort },
    specialistModel: "gpt-5.6-luna",
    defaultServiceTier: "standard",
    routes: routesForProfile(input.name),
  };
}

const profileDefinitions: ProfileDefinition[] = [
  createProfile({ name: "low", effort: "low" }),
  createProfile({ name: "default", effort: "medium" }),
  createProfile({ name: "high", effort: "high" }),
];

function validateCatalog(definitions: readonly ProfileDefinition[]): void {
  const expectedProfiles: readonly ProfileName[] = ["low", "default", "high"];
  if (definitions.length !== expectedProfiles.length) {
    throw new CoreError("catalog_invalid", "The profile catalog has an invalid size.");
  }

  for (let index = 0; index < expectedProfiles.length; index += 1) {
    const definition = definitions[index];
    const expectedProfile = expectedProfiles[index];
    if (!definition || definition.name !== expectedProfile) {
      throw new CoreError("catalog_invalid", "The profile catalog order is invalid.", { index });
    }
    const expectedEffort =
      expectedProfile === "low" ? "low" : expectedProfile === "default" ? "medium" : "high";
    if (
      definition.root.model !== "gpt-6-astra" ||
      definition.root.effort !== expectedEffort ||
      definition.specialistModel !== "gpt-5.6-luna"
    ) {
      throw new CoreError("catalog_invalid", "A profile has an invalid model route.", {
        profile: definition.name,
      });
    }
    if (definition.routes.length !== ROUTE_KEYS.length) {
      throw new CoreError("catalog_invalid", "A profile is incomplete.", {
        profile: definition.name,
      });
    }
    const seenRoutes = new Set<RouteKey>();
    for (const routeDefinition of definition.routes) {
      if (
        seenRoutes.has(routeDefinition.key) ||
        !routeKeys.has(routeDefinition.key) ||
        routeDefinition.model !== "gpt-5.6-luna" ||
        `${routeDefinition.role}:${routeDefinition.task}` !== routeDefinition.key
      ) {
        throw new CoreError("catalog_invalid", "A profile contains an invalid route.", {
          profile: definition.name,
        });
      }
      seenRoutes.add(routeDefinition.key);
    }
    if (seenRoutes.size !== ROUTE_KEYS.length) {
      throw new CoreError("catalog_invalid", "A profile is missing a specialist route.", {
        profile: definition.name,
      });
    }
  }

  for (let routeIndex = 0; routeIndex < ROUTE_KEYS.length; routeIndex += 1) {
    let previousRank = -1;
    for (const definition of definitions) {
      const routeDefinition = definition.routes[routeIndex];
      if (!routeDefinition || effortRank[routeDefinition.effort] < previousRank) {
        throw new CoreError("catalog_invalid", "Profile route effort is not monotonic.", {
          route: ROUTE_KEYS[routeIndex] ?? "unknown",
        });
      }
      previousRank = effortRank[routeDefinition.effort];
    }
  }
}

validateCatalog(profileDefinitions);
freezeDeep(profileDefinitions);
export const PROFILE_CATALOG: readonly ProfileDefinition[] = profileDefinitions;

const profilesByName = new Map<ProfileName, ProfileDefinition>();
const routesByProfile = new Map<ProfileName, ReadonlyMap<RouteKey, RouteDefinition>>();
for (const definition of PROFILE_CATALOG) {
  profilesByName.set(definition.name, definition);
  const routes = new Map<RouteKey, RouteDefinition>();
  for (const routeDefinition of definition.routes) routes.set(routeDefinition.key, routeDefinition);
  routesByProfile.set(definition.name, routes);
}

/** Look up one current product profile. Legacy values are rejected here by design. */
export function lookupProfile(input: unknown): CoreResult<ProfileDefinition> {
  const parsed = decodeUnknown(ProfileNameSchema, input);
  if (Either.isLeft(parsed)) {
    return failure(
      new CoreError(
        "invalid_profile",
        "Unknown profile selection.",
        { field: "profile" },
        { cause: parsed.left },
      ),
    );
  }
  const definition = profilesByName.get(parsed.right);
  if (!definition) {
    return failure(
      new CoreError("invalid_profile", "Unknown profile selection.", { profile: parsed.right }),
    );
  }
  return success(definition);
}

function parseRouteKey(input: unknown): CoreResult<RouteKey> {
  const parsedKey = decodeUnknown(RouteKeySchema, input);
  if (Either.isRight(parsedKey)) return success(parsedKey.right);
  const parsedRoleTask = decodeUnknown(RoleTaskSchema, input);
  if (Either.isRight(parsedRoleTask)) {
    const key = `${parsedRoleTask.right.role}:${parsedRoleTask.right.task}`;
    if (routeKeys.has(key as RouteKey)) return success(key as RouteKey);
  }
  return failure(
    new CoreError(
      "invalid_route",
      "Unknown specialist route.",
      { field: "route" },
      { cause: parsedKey.left },
    ),
  );
}

/** Resolve a specialist route for a current product profile. */
export function lookupRoute(
  profileInput: unknown,
  routeInput: unknown,
): CoreResult<RouteDefinition> {
  const profileResult = lookupProfile(profileInput);
  if (!profileResult.ok) return profileResult;
  const routeResult = parseRouteKey(routeInput);
  if (!routeResult.ok) return routeResult;
  const routeDefinition = routesByProfile.get(profileResult.value.name)?.get(routeResult.value);
  if (!routeDefinition) {
    return failure(
      new CoreError("invalid_route", "The route is not available for the selected profile.", {
        profile: profileResult.value.name,
        route: routeResult.value,
      }),
    );
  }
  return success(routeDefinition);
}

/** Resolve a validated product profile and independent service tier. */
export function resolveProfileSelection(input: unknown): CoreResult<{
  readonly profile: ProfileDefinition;
  readonly serviceTier: ServiceTier;
}> {
  const selection = parseProfileSelection(input);
  if (!selection.ok) return selection;
  const profileResult = lookupProfile(selection.value.profile);
  if (!profileResult.ok) return profileResult;
  return success({
    profile: profileResult.value,
    serviceTier: selection.value.service_tier ?? profileResult.value.defaultServiceTier,
  });
}
