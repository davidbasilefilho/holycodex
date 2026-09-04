// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

export const CapabilityNameSchema = Schema.Literal("computer_use", "work", "frontend", "security");
export type CapabilityName = typeof CapabilityNameSchema.Type;

export const OptionalCapabilityNameSchema = Schema.Literal(
  "computer_use",
  "work",
  "frontend",
  "security",
);
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
  (typeof OFFICIAL_OPENAI_CURATED_MARKETPLACE_NAMES)[number];

/** Plugin names whose OpenAI curated identities are part of HolyCodex's capability contract. */
export const OFFICIAL_OPENAI_CURATED_PLUGIN_NAMES = Object.freeze([
  "build-web-apps",
  "codex-security",
] as const);
export type OfficialOpenAiCuratedPluginName = (typeof OFFICIAL_OPENAI_CURATED_PLUGIN_NAMES)[number];

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
  return isOfficialOpenAiCuratedPluginName(pluginName) &&
    isOfficialOpenAiCuratedMarketplaceName(marketplaceName)
    ? `${pluginName}@openai-curated`
    : undefined;
}

/** Return all trusted runtime ids for a canonical OpenAI curated provider id. */
export function officialPluginIdCandidates(pluginId: string): readonly string[] {
  const canonical = canonicalOfficialPluginId(pluginId);
  if (canonical === undefined) return [];
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
  readonly work: boolean;
  readonly frontend: boolean;
  readonly security: boolean;
}>;

export const DEFAULT_CAPABILITY_SELECTIONS: CapabilityDefaults = Object.freeze({
  coding: true,
  computer_use: false,
  work: false,
  frontend: true,
  security: true,
});

export type CapabilityDefinition = Readonly<{
  readonly name: OptionalCapabilityName;
  readonly pluginIds: readonly string[];
  readonly defaultSelected: boolean;
  readonly migrationKey: OptionalCapabilityName;
  readonly semanticSkillIds: readonly string[];
  readonly ownership: "shared-preserve";
}>;

const registry: Record<OptionalCapabilityName, CapabilityDefinition> = {
  work: {
    name: "work",
    pluginIds: [
      "documents@openai-primary-runtime",
      "pdf@openai-primary-runtime",
      "presentations@openai-primary-runtime",
      "spreadsheets@openai-primary-runtime",
      "template-creator@openai-primary-runtime",
    ],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.work,
    migrationKey: "work",
    semanticSkillIds: [
      "documents:documents",
      "pdf:pdf",
      "presentations:Presentations",
      "spreadsheets:Spreadsheets",
      "template-creator:template-creator",
    ],
    ownership: "shared-preserve",
  },
  frontend: {
    name: "frontend",
    pluginIds: ["build-web-apps@openai-curated"],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.frontend,
    migrationKey: "frontend",
    semanticSkillIds: [
      "build-web-apps:frontend-app-builder",
      "build-web-apps:frontend-testing-debugging",
      "build-web-apps:react-best-practices",
    ],
    ownership: "shared-preserve",
  },
  security: {
    name: "security",
    pluginIds: ["codex-security@openai-curated"],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.security,
    migrationKey: "security",
    semanticSkillIds: [
      "codex-security:security-scan",
      "codex-security:security-diff-scan",
      "codex-security:threat-model",
    ],
    ownership: "shared-preserve",
  },
  computer_use: {
    name: "computer_use",
    pluginIds: ["computer-use@openai-bundled"],
    defaultSelected: DEFAULT_CAPABILITY_SELECTIONS.computer_use,
    migrationKey: "computer_use",
    semanticSkillIds: ["computer-use:computer-use"],
    ownership: "shared-preserve",
  },
};

export const CAPABILITY_REGISTRY: Readonly<Record<OptionalCapabilityName, CapabilityDefinition>> =
  Object.freeze(registry);

export const OPTIONAL_CAPABILITY_NAMES: readonly OptionalCapabilityName[] = Object.freeze([
  "computer_use",
  "work",
  "frontend",
  "security",
]);

export type OptionalCapabilitySelections = Readonly<{
  readonly computer_use: boolean;
  readonly work: boolean;
  readonly frontend: boolean;
  readonly security: boolean;
}>;

export type ExplicitOptionalCapabilitySelections = Readonly<
  Partial<Record<OptionalCapabilityName, boolean | undefined>>
>;

export const DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS: OptionalCapabilitySelections = Object.freeze({
  computer_use: DEFAULT_CAPABILITY_SELECTIONS.computer_use,
  work: DEFAULT_CAPABILITY_SELECTIONS.work,
  frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
  security: DEFAULT_CAPABILITY_SELECTIONS.security,
});

export function migrateOptionalCapabilitySelections(
  input: Readonly<Record<string, unknown>> | undefined,
): OptionalCapabilitySelections {
  return {
    computer_use: input?.[CAPABILITY_REGISTRY.computer_use.migrationKey] === true,
    work: input?.[CAPABILITY_REGISTRY.work.migrationKey] === true,
    frontend: input?.[CAPABILITY_REGISTRY.frontend.migrationKey] === true,
    security: input?.[CAPABILITY_REGISTRY.security.migrationKey] === true,
  };
}

export function resolveOptionalCapabilitySelections(
  requested: ExplicitOptionalCapabilitySelections | undefined,
  previous: OptionalCapabilitySelections | undefined,
): OptionalCapabilitySelections {
  const fallback = previous ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS;
  return {
    computer_use: requested?.computer_use ?? fallback.computer_use,
    work: requested?.work ?? fallback.work,
    frontend: requested?.frontend ?? fallback.frontend,
    security: requested?.security ?? fallback.security,
  };
}

export function pluginIdsForOptionalCapabilities(
  selections: OptionalCapabilitySelections,
  additionalPluginIds: readonly string[] = [],
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
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
