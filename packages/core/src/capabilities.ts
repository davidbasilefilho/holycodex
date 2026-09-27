// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

export const CapabilityNameSchema = Schema.Literal(
  "browser_use",
  "computer_use",
  "frontend",
  "security",
  "sites",
);
export type CapabilityName = typeof CapabilityNameSchema.Type;

export const OptionalCapabilityNameSchema = Schema.Literal("browser_use", "computer_use", "sites");
export type OptionalCapabilityName = typeof OptionalCapabilityNameSchema.Type;

export const CapabilityProviderStatusSchema = Schema.Literal(
  "installed",
  "disabled",
  "missing",
  "uncertain",
);
export type CapabilityProviderStatus = typeof CapabilityProviderStatusSchema.Type;

export const CapabilityHealthSchema = Schema.Literal("healthy", "missing", "disabled", "uncertain");
export type CapabilityHealth = typeof CapabilityHealthSchema.Type;

/**
 * Marketplace names Codex currently uses for the trusted OpenAI curated provider.
 *
 * The remote suffix is a runtime identity variant, not a third-party marketplace. The marketplace
 * name must still agree with the plugin id suffix before an observed plugin is accepted as
 * equivalent.
 */
export const OFFICIAL_OPENAI_CURATED_MARKETPLACE_NAMES = Object.freeze([
  "openai-curated",
  "openai-curated-remote",
] as const);
export type OfficialOpenAiCuratedMarketplaceName =
  | (typeof OFFICIAL_OPENAI_CURATED_MARKETPLACE_NAMES)[number]
  | "openai-bundled";

/** Plugin names whose OpenAI curated identities are part of HolyCodex's capability contract. */
export const OFFICIAL_OPENAI_CURATED_PLUGIN_NAMES = Object.freeze([
  "build-web-apps",
  "codex-security",
] as const);
export const OFFICIAL_OPENAI_BUNDLED_PLUGIN_NAMES = Object.freeze([
  "browser",
  "computer-use",
  "sites",
] as const);
export type OfficialOpenAiCuratedPluginName =
  | (typeof OFFICIAL_OPENAI_CURATED_PLUGIN_NAMES)[number]
  | (typeof OFFICIAL_OPENAI_BUNDLED_PLUGIN_NAMES)[number];

export type OfficialPluginIdentity = Readonly<{
  readonly pluginName: OfficialOpenAiCuratedPluginName;
  readonly marketplaceName: OfficialOpenAiCuratedMarketplaceName;
  readonly canonicalPluginId: string;
}>;

/**
 * Resolve a live plugin id and marketplace name to a trusted OpenAI curated identity.
 *
 * Both values are required and must agree. This intentionally rejects an arbitrary marketplace that
 * happens to publish a plugin with the same name.
 */
export function resolveOfficialPluginIdentity(
  pluginId: string,
  marketplaceName: string | null | undefined,
): OfficialPluginIdentity | undefined {
  if (typeof marketplaceName !== "string") return undefined;
  const separator = pluginId.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const pluginName = pluginId.slice(0, separator);
  const idMarketplaceName = pluginId.slice(separator + 1);
  if (
    pluginName === "sites" &&
    idMarketplaceName === "openai-curated-remote" &&
    marketplaceName === idMarketplaceName
  ) {
    return {
      pluginName,
      marketplaceName: idMarketplaceName,
      canonicalPluginId: "sites@openai-bundled",
    };
  }
  if (
    (OFFICIAL_OPENAI_BUNDLED_PLUGIN_NAMES as readonly string[]).includes(pluginName) &&
    idMarketplaceName === "openai-bundled" &&
    marketplaceName === idMarketplaceName
  ) {
    return {
      pluginName: pluginName as OfficialOpenAiCuratedPluginName,
      marketplaceName: idMarketplaceName,
      canonicalPluginId: pluginId,
    };
  }
  if (
    !isOfficialOpenAiCuratedPluginName(pluginName) ||
    !isOfficialOpenAiCuratedMarketplaceName(idMarketplaceName) ||
    marketplaceName !== idMarketplaceName
  ) {
    return undefined;
  }
  return {
    pluginName,
    marketplaceName: idMarketplaceName,
    canonicalPluginId: `${pluginName}@openai-curated`,
  };
}

/** Return the canonical provider id for a recognized OpenAI curated id. */
export function canonicalOfficialPluginId(pluginId: string): string | undefined {
  const separator = pluginId.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const pluginName = pluginId.slice(0, separator);
  const marketplaceName = pluginId.slice(separator + 1);
  if (pluginName === "sites" && marketplaceName === "openai-curated-remote")
    return "sites@openai-bundled";
  if (
    isOfficialOpenAiCuratedPluginName(pluginName) &&
    isOfficialOpenAiCuratedMarketplaceName(marketplaceName)
  )
    return `${pluginName}@openai-curated`;
  if (
    (OFFICIAL_OPENAI_BUNDLED_PLUGIN_NAMES as readonly string[]).includes(pluginName) &&
    marketplaceName === "openai-bundled"
  )
    return `${pluginName}@openai-bundled`;
  return undefined;
}

/** Return all trusted runtime ids for a canonical OpenAI curated provider id. */
export function officialPluginIdCandidates(pluginId: string): readonly string[] {
  const canonical = canonicalOfficialPluginId(pluginId);
  if (canonical === undefined) return [];
  if (canonical === "sites@openai-bundled") {
    return Object.freeze([canonical, "sites@openai-curated-remote"]);
  }
  if (canonical.endsWith("@openai-bundled")) return Object.freeze([canonical]);
  const pluginName = canonical.slice(0, canonical.lastIndexOf("@"));
  return Object.freeze([canonical, `${pluginName}@openai-curated-remote`]);
}

function isOfficialOpenAiCuratedMarketplaceName(
  value: string,
): value is OfficialOpenAiCuratedMarketplaceName {
  return (OFFICIAL_OPENAI_CURATED_MARKETPLACE_NAMES as readonly string[]).includes(value);
}

function isOfficialOpenAiCuratedPluginName(
  value: string,
): value is OfficialOpenAiCuratedPluginName {
  return (OFFICIAL_OPENAI_CURATED_PLUGIN_NAMES as readonly string[]).includes(value);
}

/** Canonical capability selection defaults consumed by installers and state migration. */
export type CapabilityDefaults = Readonly<{
  readonly coding: true;
  readonly computer_use: boolean;
  readonly browser_use: boolean;
  readonly sites: boolean;
  readonly frontend: true;
  readonly security: true;
}>;

export const DEFAULT_CAPABILITY_SELECTIONS: CapabilityDefaults = Object.freeze({
  coding: true,
  computer_use: false,
  browser_use: true,
  sites: true,
  frontend: true,
  security: true,
});

export type CapabilityDefinition = Readonly<{
  readonly name: CapabilityName;
  readonly pluginIds: readonly string[];
  readonly defaultSelected: boolean;
  readonly migrationKey?: OptionalCapabilityName;
  readonly semanticSkillIds: readonly string[];
  readonly applicability: readonly CapabilityApplicability[];
  readonly ownership: "shared-preserve";
}>;

/** One canonical semantic skill mapping for a selected capability. */
export type CapabilityApplicability = Readonly<{
  readonly skillId: string;
  readonly appliesWhen: string;
}>;

/** Canonical frontend skill selection rules projected into Root instructions. */
export const CAPABILITY_APPLICABILITY = Object.freeze({
  frontend: Object.freeze([
    {
      skillId: "build-web-apps:frontend-app-builder",
      appliesWhen: "a new visually-driven UI or meaningful redesign",
    },
    {
      skillId: "build-web-apps:frontend-testing-debugging",
      appliesWhen: "a rendered UI or interaction defect",
    },
    {
      skillId: "build-web-apps:react-best-practices",
      appliesWhen: "a relevant React or Next implementation or review",
    },
  ] as const),
  security: Object.freeze([] as const),
  computer_use: Object.freeze([] as const),
  browser_use: Object.freeze([] as const),
  sites: Object.freeze([] as const),
} satisfies Readonly<Record<CapabilityName, readonly CapabilityApplicability[]>>);

/** Canonical frontend applicability mappings. */
export const FRONTEND_CAPABILITY_APPLICABILITY = CAPABILITY_APPLICABILITY.frontend;

const registry: Record<CapabilityName, CapabilityDefinition> = {
  frontend: {
    name: "frontend",
    pluginIds: ["build-web-apps@openai-curated"],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.frontend,
    semanticSkillIds: Object.freeze(
      CAPABILITY_APPLICABILITY.frontend.map(({ skillId }) => skillId),
    ),
    applicability: CAPABILITY_APPLICABILITY.frontend,
    ownership: "shared-preserve",
  },
  security: {
    name: "security",
    pluginIds: ["codex-security@openai-curated"],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.security,
    semanticSkillIds: [
      "codex-security:security-scan",
      "codex-security:security-diff-scan",
      "codex-security:threat-model",
    ],
    applicability: CAPABILITY_APPLICABILITY.security,
    ownership: "shared-preserve",
  },
  computer_use: {
    name: "computer_use",
    pluginIds: ["computer-use@openai-bundled"],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.computer_use,
    migrationKey: "computer_use",
    semanticSkillIds: ["computer-use:computer-use"],
    applicability: CAPABILITY_APPLICABILITY.computer_use,
    ownership: "shared-preserve",
  },
  browser_use: {
    name: "browser_use",
    pluginIds: ["browser@openai-bundled"],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.browser_use,
    migrationKey: "browser_use",
    semanticSkillIds: [],
    applicability: CAPABILITY_APPLICABILITY.browser_use,
    ownership: "shared-preserve",
  },
  sites: {
    name: "sites",
    pluginIds: ["sites@openai-bundled"],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.sites,
    migrationKey: "sites",
    semanticSkillIds: [],
    applicability: CAPABILITY_APPLICABILITY.sites,
    ownership: "shared-preserve",
  },
};

export const CAPABILITY_REGISTRY: Readonly<Record<CapabilityName, CapabilityDefinition>> =
  Object.freeze(registry);

export const OPTIONAL_CAPABILITY_NAMES: readonly OptionalCapabilityName[] = Object.freeze([
  "browser_use",
  "computer_use",
  "sites",
]);
export const REQUIRED_CAPABILITY_NAMES = Object.freeze(["frontend", "security"] as const);
export const REQUIRED_CAPABILITY_PLUGIN_IDS = Object.freeze([
  ...CAPABILITY_REGISTRY.frontend.pluginIds,
  ...CAPABILITY_REGISTRY.security.pluginIds,
] as const);

export type OptionalCapabilitySelections = Readonly<{
  readonly browser_use: boolean;
  readonly computer_use: boolean;
  readonly sites: boolean;
}>;

/** Canonical always-present workflow skills projected by the HolyCodex plugin. */
export const CORE_SEMANTIC_SKILL_IDS = Object.freeze([
  "writing-instructions",
  "babysit-ci",
] as const);

export type ExplicitOptionalCapabilitySelections = Readonly<
  Partial<Record<OptionalCapabilityName, boolean | undefined>>
>;

export const DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS: OptionalCapabilitySelections = Object.freeze({
  browser_use: DEFAULT_CAPABILITY_SELECTIONS.browser_use,
  computer_use: DEFAULT_CAPABILITY_SELECTIONS.computer_use,
  sites: DEFAULT_CAPABILITY_SELECTIONS.sites,
});

/** Migrate persisted capability flags, ignoring legacy capabilities that are no longer managed. */
export function migrateOptionalCapabilitySelections(
  input: Readonly<Record<string, unknown>> | undefined,
): OptionalCapabilitySelections {
  // Legacy `work` is deliberately ignored. Shared document providers are no longer managed by a
  // live capability and remain user-owned during migration/removal.
  return {
    browser_use: input?.["browser_use"] === true,
    computer_use: input?.["computer_use"] === true,
    sites: input?.["sites"] === true,
  };
}

/** Resolve requested capability flags against previous selections and canonical defaults. */
export function resolveOptionalCapabilitySelections(
  requested: ExplicitOptionalCapabilitySelections | undefined,
  previous: OptionalCapabilitySelections | undefined,
): OptionalCapabilitySelections {
  const fallback = previous ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS;
  return {
    browser_use: requested?.browser_use ?? fallback.browser_use,
    computer_use: requested?.computer_use ?? fallback.computer_use,
    sites: requested?.sites ?? fallback.sites,
  };
}

/** Collect selected capability plugin ids, then append unique additional plugin ids in order. */
export function pluginIdsForOptionalCapabilities(
  selections: OptionalCapabilitySelections,
  additionalPluginIds: readonly string[] = [],
): readonly string[] {
  const ids: string[] = [...REQUIRED_CAPABILITY_PLUGIN_IDS];
  const seen = new Set<string>(ids);
  for (const name of OPTIONAL_CAPABILITY_NAMES) {
    if (!selections[name]) continue;
    for (const pluginId of CAPABILITY_REGISTRY[name].pluginIds) {
      if (!seen.has(pluginId)) {
        seen.add(pluginId);
        ids.push(pluginId);
      }
    }
  }
  for (const pluginId of additionalPluginIds) {
    if (!seen.has(pluginId)) {
      seen.add(pluginId);
      ids.push(pluginId);
    }
  }
  return ids;
}

/** Map a selected capability's provider status to its user-facing health state. */
export function capabilityHealth(
  selected: boolean,
  providerStatus: CapabilityProviderStatus | undefined,
): CapabilityHealth {
  if (!selected) return "healthy";
  switch (providerStatus) {
    case "installed":
      return "healthy";
    case "disabled":
      return "disabled";
    case "uncertain":
      return "uncertain";
    case "missing":
    case undefined:
      return "missing";
  }
}
