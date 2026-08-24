// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

export const CapabilityNameSchema = Schema.Literal(
  "computer_use",
  "work",
  "web",
  "security",
  "lsp",
  "lsp_setup",
  "git_bash",
);
export type CapabilityName = typeof CapabilityNameSchema.Type;

export const OptionalCapabilityNameSchema = Schema.Literal(
  "computer_use",
  "work",
  "web",
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

export type CapabilityDefinition = Readonly<{
  readonly name: OptionalCapabilityName;
  readonly pluginIds: readonly string[];
  readonly defaultSelected: false;
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
    defaultSelected: false,
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
  web: {
    name: "web",
    pluginIds: ["build-web-apps@openai-curated"],
    defaultSelected: false,
    migrationKey: "web",
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
    defaultSelected: false,
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
    defaultSelected: false,
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
  "web",
  "security",
]);

export type OptionalCapabilitySelections = Readonly<{
  readonly computer_use: boolean;
  readonly work: boolean;
  readonly web: boolean;
  readonly security: boolean;
}>;

export type ExplicitOptionalCapabilitySelections = Readonly<
  Partial<Record<OptionalCapabilityName, boolean | undefined>>
>;

export const DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS: OptionalCapabilitySelections = Object.freeze({
  computer_use: false,
  work: false,
  web: false,
  security: false,
});

export function migrateOptionalCapabilitySelections(
  input: Readonly<Record<string, unknown>> | undefined,
): OptionalCapabilitySelections {
  return {
    computer_use: input?.[CAPABILITY_REGISTRY.computer_use.migrationKey] === true,
    work: input?.[CAPABILITY_REGISTRY.work.migrationKey] === true,
    web: input?.[CAPABILITY_REGISTRY.web.migrationKey] === true,
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
    web: requested?.web ?? fallback.web,
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
