// SPDX-License-Identifier: Apache-2.0

import * as Result from "effect/Result";

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

/** Canonical astra model id used by core domain operations. */
export const ASTRA_MODEL_ID = "gpt-6-astra" as const;
/** Canonical sol model id used by core domain operations. */
export const SOL_MODEL_ID = "gpt-6.1-sol" as const;
/** Canonical luna model id used by core domain operations. */
export const LUNA_MODEL_ID = "gpt-6-luna" as const;

/** Decode the canonical product profile selection used by routing. */
export function parseProfileSelection(input: unknown): CoreResult<ProfileSelection> {
  const parsed = decodeUnknown(ProfileSelectionSchema, input);
  if (Result.isFailure(parsed)) return failure(inputError("profile selection", parsed.failure));
  return success(parsed.success);
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
/** Single source of truth for the specialist effort matrix for live profiles. */
export const ROUTE_EFFORT_OVERRIDES = [
  {
    profile: "low",
    rationale:
      "Cheapest practical configuration without dropping Luna below its useful agentic threshold.",
    efforts: {
      "Explorer:map": "medium",
      "Explorer:lookup": "medium",
      "Explorer:trace": "high",
      "Librarian:lookup": "medium",
      "Librarian:research": "high",
      "Worker:mechanical": "medium",
      "Worker:implementation": "high",
      "Worker:integration": "high",
      "Worker:operations": "medium",
      "Worker:validation": "medium",
      "Worker:debugging": "high",
      "Worker:visual": "high",
      "Reviewer:code": "high",
      "Reviewer:testing": "medium",
      "Reviewer:audit": "medium",
      "Reviewer:security": "high",
      "Reviewer:artifact": "high",
      "Reviewer:visual": "high",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
  {
    profile: "default",
    rationale:
      "Best general whole-task cost/performance: Sol medium orchestration and Luna medium/high execution.",
    efforts: {
      "Explorer:map": "medium",
      "Explorer:lookup": "medium",
      "Explorer:trace": "high",
      "Librarian:lookup": "medium",
      "Librarian:research": "high",
      "Worker:mechanical": "medium",
      "Worker:implementation": "high",
      "Worker:integration": "high",
      "Worker:operations": "medium",
      "Worker:validation": "high",
      "Worker:debugging": "high",
      "Worker:visual": "high",
      "Reviewer:code": "high",
      "Reviewer:testing": "high",
      "Reviewer:audit": "high",
      "Reviewer:security": "high",
      "Reviewer:artifact": "high",
      "Reviewer:visual": "high",
    } satisfies Readonly<Record<RouteKey, Effort>>,
  },
  {
    profile: "high",
    rationale:
      "Highest practical reliability without indiscriminate reasoning waste; use high effort consistently across all live routes.",
    efforts: {
      "Explorer:map": "high",
      "Explorer:lookup": "medium",
      "Explorer:trace": "high",
      "Librarian:lookup": "high",
      "Librarian:research": "high",
      "Worker:mechanical": "high",
      "Worker:implementation": "high",
      "Worker:integration": "high",
      "Worker:operations": "high",
      "Worker:validation": "high",
      "Worker:debugging": "high",
      "Worker:visual": "high",
      "Reviewer:code": "high",
      "Reviewer:testing": "high",
      "Reviewer:audit": "high",
      "Reviewer:security": "high",
      "Reviewer:artifact": "high",
      "Reviewer:visual": "high",
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
  input: Readonly<{
    readonly name: ProfileName;
    readonly rootModel: typeof SOL_MODEL_ID | typeof ASTRA_MODEL_ID;
    readonly rootEffort: Effort;
  }>,
): ProfileDefinition {
  return {
    name: input.name,
    root: { model: input.rootModel, effort: input.rootEffort },
    specialistModel: LUNA_MODEL_ID,
    defaultServiceTier: "standard",
    routes: routesForProfile(input.name),
  };
}

const profileDefinitions: ProfileDefinition[] = [
  createProfile({ name: "low", rootModel: SOL_MODEL_ID, rootEffort: "low" }),
  createProfile({ name: "default", rootModel: SOL_MODEL_ID, rootEffort: "medium" }),
  createProfile({ name: "high", rootModel: SOL_MODEL_ID, rootEffort: "medium" }),
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
    const expectedModel = SOL_MODEL_ID;
    const expectedEffort = expectedProfile === "low" ? "low" : "medium";
    if (
      definition.root.model !== expectedModel ||
      definition.root.effort !== expectedEffort ||
      definition.specialistModel !== LUNA_MODEL_ID
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
        routeDefinition.model !== LUNA_MODEL_ID ||
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
}

validateCatalog(profileDefinitions);
freezeDeep(profileDefinitions);
/** Canonical profile catalog used by core domain operations. */
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
  if (Result.isFailure(parsed)) {
    return failure(
      new CoreError(
        "invalid_profile",
        "Unknown profile selection.",
        { field: "profile" },
        { cause: parsed.failure },
      ),
    );
  }
  const definition = profilesByName.get(parsed.success);
  if (!definition) {
    return failure(
      new CoreError("invalid_profile", "Unknown profile selection.", { profile: parsed.success }),
    );
  }
  return success(definition);
}

function parseRouteKey(input: unknown): CoreResult<RouteKey> {
  const parsedKey = decodeUnknown(RouteKeySchema, input);
  if (Result.isSuccess(parsedKey)) return success(parsedKey.success);
  const parsedRoleTask = decodeUnknown(RoleTaskSchema, input);
  if (Result.isSuccess(parsedRoleTask)) {
    const key = `${parsedRoleTask.success.role}:${parsedRoleTask.success.task}`;
    if (routeKeys.has(key as RouteKey)) return success(key as RouteKey);
  }
  return failure(
    new CoreError(
      "invalid_route",
      "Unknown specialist route.",
      { field: "route" },
      { cause: parsedKey.failure },
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
