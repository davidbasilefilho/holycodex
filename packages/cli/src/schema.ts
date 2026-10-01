// SPDX-License-Identifier: Apache-2.0

import { ManagedRuntimeConfigStateSchema } from "@holycodex/codex";
import {
  ReleaseVersionSchema,
  decodeUnknown,
  CapabilityNameSchema,
  OptionalCapabilityNameSchema,
  ProfileNameSchema,
  ProfileNameMigrationSchema,
  ServiceTierSchema,
  STATE_SCHEMA_EPOCH,
  type JsonObject,
} from "@holycodex/core";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** Schema for json object values. */
export const JsonObjectSchema = Schema.JsonObject;
/** Schema for json value values. */
export const JsonValueSchema = Schema.Json;
/** The persisted and detected package version, including a release suffix. */
export const VersionSchema = ReleaseVersionSchema;
/** Versions reported by external tools such as Context7 may use their own semver line. */
const ToolVersionSchema = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
);
/** Schema for digest values. */
export const DigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
/** Schema for identifier values. */
export const IdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
);
/** Schema for official plugin id values. */
export const OfficialPluginIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u),
);
/** Schema for date text values. */
export const DateTextSchema = Schema.String.check(
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value))),
);
/** Schema for managed artifact values. */
export const ManagedArtifactSchema = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u)),
  digest: DigestSchema,
});

/** Schema for optional selections values. */
export const OptionalSelectionsSchema = Schema.Struct({
  browser_use: Schema.Boolean,
  computer_use: Schema.Boolean,
  sites: Schema.Boolean,
  coding: Schema.Literals([true]),
});
/** Schema for explicit optional selections values. */
export const ExplicitOptionalSelectionsSchema = Schema.Struct({
  browser_use: Schema.optional(Schema.Boolean),
  computer_use: Schema.optional(Schema.Boolean),
  sites: Schema.optional(Schema.Boolean),
});
/** Schema for install request values. */
export const InstallRequestSchema = Schema.Struct({
  profile: Schema.optional(ProfileNameSchema),
  tier: Schema.optional(ServiceTierSchema),
  optional: Schema.optional(ExplicitOptionalSelectionsSchema),
  officialPlugins: Schema.optional(Schema.Array(OfficialPluginIdSchema)),
});
/** Canonical validated domain schema shared by CLI flags and the TTY wizard. */
export const InstallOptionsSchema = InstallRequestSchema;

/** A decision allowed by the managed conflict review boundary. */
export const ConflictDecisionSchema = Schema.Literals(["keep", "remove", "replace", "cancel"]);

/** Schema for the small, user-owned install options file. */
export const PersistedInstallOptionsSchema = Schema.Struct({
  schema_version: Schema.Literals([1]),
  profile: ProfileNameSchema,
  tier: ServiceTierSchema,
  capabilities: Schema.Array(OptionalCapabilityNameSchema),
  additional_plugins: Schema.Array(OfficialPluginIdSchema),
});
/** Schema for persisted install options migration values. */
export const PersistedInstallOptionsMigrationSchema = Schema.Struct({
  schema_version: Schema.Literals([1]),
  profile: ProfileNameSchema,
  tier: ServiceTierSchema,
  capabilities: Schema.Array(CapabilityNameSchema),
  additional_plugins: Schema.Array(OfficialPluginIdSchema),
});

/** Schema for capability install state values. */
export const CapabilityInstallStateSchema = Schema.Struct({
  selected: Schema.Boolean,
  status: Schema.Literals([
    "disabled",
    "pending",
    "healthy",
    "missing",
    "provider_disabled",
    "uncertain",
    "unavailable",
  ]),
  plugin_ids: Schema.Array(OfficialPluginIdSchema),
  reason: Schema.optional(Schema.String),
});
/** Schema for capability state record values. */
export const CapabilityStateRecordSchema = Schema.Struct({
  browser_use: CapabilityInstallStateSchema,
  computer_use: CapabilityInstallStateSchema,
  frontend: CapabilityInstallStateSchema,
  security: CapabilityInstallStateSchema,
  sites: CapabilityInstallStateSchema,
});

const LegacyOptionalSelectionsSchema = Schema.Struct({
  browser_use: Schema.optional(Schema.Boolean),
  computer_use: Schema.Boolean,
  frontend: Schema.Boolean,
  security: Schema.Boolean,
  sites: Schema.optional(Schema.Boolean),
  coding: Schema.Literals([true]),
  work: Schema.Boolean,
});
const LegacyExplicitOptionalSelectionsSchema = Schema.Struct({
  browser_use: Schema.optional(Schema.Boolean),
  computer_use: Schema.optional(Schema.Boolean),
  frontend: Schema.optional(Schema.Boolean),
  security: Schema.optional(Schema.Boolean),
  sites: Schema.optional(Schema.Boolean),
  work: Schema.optional(Schema.Boolean),
});
const LegacyCapabilityStateRecordSchema = Schema.Struct({
  browser_use: Schema.optional(CapabilityInstallStateSchema),
  computer_use: CapabilityInstallStateSchema,
  frontend: CapabilityInstallStateSchema,
  security: CapabilityInstallStateSchema,
  sites: Schema.optional(CapabilityInstallStateSchema),
  work: CapabilityInstallStateSchema,
});
const PreviousOptionalSelectionsSchema = Schema.Struct({
  computer_use: Schema.Boolean,
  frontend: Schema.Boolean,
  security: Schema.Boolean,
  coding: Schema.Literals([true]),
});
const PreviousExplicitOptionalSelectionsSchema = Schema.Struct({
  computer_use: Schema.optional(Schema.Boolean),
  frontend: Schema.optional(Schema.Boolean),
  security: Schema.optional(Schema.Boolean),
});
const PreviousCapabilityStateRecordSchema = Schema.Struct({
  computer_use: CapabilityInstallStateSchema,
  frontend: CapabilityInstallStateSchema,
  security: CapabilityInstallStateSchema,
});

const GitBashStateSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["not_applicable"]) }),
  Schema.Struct({ status: Schema.Literals(["missing"]) }),
  Schema.Struct({
    status: Schema.Literals(["healthy"]),
    path: Schema.String,
    installed: Schema.Boolean,
  }),
]);
const Context7ToolStateSchema = Schema.Struct({
  manager: Schema.Literals(["bun", "npm", "pnpm"]),
  launcher: Schema.Literals(["bunx", "npx", "pnpm dlx"]),
  version: ToolVersionSchema,
  executable: Schema.String,
  ownership: Schema.Literals(["user", "holycodex"]),
  identity: Schema.optional(DigestSchema),
});
/** Schema for installer tooling state values. */
export const InstallerToolingStateSchema = Schema.Struct({
  git_bash: Schema.optional(GitBashStateSchema),
  context7: Schema.optional(Context7ToolStateSchema),
});

const PluginConfigEntrySnapshotSchema = Schema.Struct({
  presence: Schema.Literals(["absent", "present"]),
  digest: DigestSchema,
  safe_value: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literals(["boolean"]), value: Schema.Boolean }),
      Schema.Struct({
        kind: Schema.Literals(["marketplace"]),
        source_type: Schema.Literals(["git"]),
        source: Schema.Literals(["https://github.com/davidbasilefilho/holycodex.git"]),
      }),
    ]),
  ),
});
/** Schema for plugin config snapshot values. */
export const PluginConfigSnapshotSchema = Schema.Struct({
  plugin_id: Schema.Literals(["holycodex@holycodex"]),
  before: Schema.Struct({
    preference: PluginConfigEntrySnapshotSchema,
    marketplace: PluginConfigEntrySnapshotSchema,
  }),
  after: Schema.Struct({
    preference: PluginConfigEntrySnapshotSchema,
    marketplace: PluginConfigEntrySnapshotSchema,
  }),
});
const ProviderPluginConfigEntrySnapshotSchema = Schema.Struct({
  presence: Schema.Literals(["absent", "present"]),
  digest: DigestSchema,
  safe_value: Schema.optional(
    Schema.Struct({ kind: Schema.Literals(["boolean"]), value: Schema.Boolean }),
  ),
});
const ProviderPluginConfigSnapshotSchema = Schema.Struct({
  plugin_id: OfficialPluginIdSchema,
  before: ProviderPluginConfigEntrySnapshotSchema,
  after: ProviderPluginConfigEntrySnapshotSchema,
});

const InstallRecordFields = {
  owner: Schema.Literals(["holycodex"]),
  schema_epoch: Schema.Literals([STATE_SCHEMA_EPOCH]),
  install_id: IdentifierSchema,
  version: VersionSchema,
  digest: DigestSchema,
  profile: ProfileNameSchema,
  tier: ServiceTierSchema,
  optional_selections: OptionalSelectionsSchema,
  explicit_optional_selections: ExplicitOptionalSelectionsSchema,
  official_plugins: Schema.optional(Schema.Array(OfficialPluginIdSchema)),
  capability_state: Schema.optional(CapabilityStateRecordSchema),
  managed_artifacts: Schema.Array(ManagedArtifactSchema),
  installed_at: DateTextSchema,
  status: Schema.optional(Schema.Literals(["active"])),
  step: Schema.optional(Schema.Literals(["active"])),
  managed_config: Schema.optional(ManagedRuntimeConfigStateSchema),
  plugin_snapshot: Schema.optional(
    Schema.Array(
      Schema.Struct({
        plugin_id: OfficialPluginIdSchema,
        status: Schema.Literals([
          "installed",
          "available",
          "missing",
          "disabled",
          "uncertain",
          "unknown",
        ]),
      }),
    ),
  ),
  plugin_config: Schema.optional(PluginConfigSnapshotSchema),
  provider_config: Schema.optional(Schema.Array(ProviderPluginConfigSnapshotSchema)),
  owned_plugins: Schema.optional(Schema.Array(OfficialPluginIdSchema)),
  tooling: Schema.optional(InstallerToolingStateSchema),
} as const;
/** Schema for install record values. */
export const InstallRecordSchema = Schema.Struct(InstallRecordFields);
const LegacyInstallRecordBaseFields = (({ profile: _profile, ...fields }) => fields)(
  InstallRecordFields,
);
const LegacyInstallRecordFields = {
  ...InstallRecordFields,
  optional_selections: LegacyOptionalSelectionsSchema,
  explicit_optional_selections: LegacyExplicitOptionalSelectionsSchema,
  capability_state: Schema.optional(LegacyCapabilityStateRecordSchema),
} as const;
const LegacyInstallRecordWithoutProfile = (({ profile: _profile, ...fields }) => fields)(
  LegacyInstallRecordFields,
);
const PreviousInstallRecordFields = {
  ...InstallRecordFields,
  optional_selections: PreviousOptionalSelectionsSchema,
  explicit_optional_selections: PreviousExplicitOptionalSelectionsSchema,
  capability_state: Schema.optional(PreviousCapabilityStateRecordSchema),
} as const;
const PreviousInstallRecordWithoutProfile = (({ profile: _profile, ...fields }) => fields)(
  PreviousInstallRecordFields,
);
/** Accept one pre-profile record shape only at the migration boundary. */
export const InstallRecordMigrationSchema = Schema.Union([
  Schema.Struct({
    ...LegacyInstallRecordFields,
    profile: ProfileNameMigrationSchema,
  }),
  Schema.Struct({
    ...LegacyInstallRecordWithoutProfile,
    plan: ProfileNameMigrationSchema,
  }),
  Schema.Struct({
    ...LegacyInstallRecordBaseFields,
    plan: ProfileNameMigrationSchema,
  }),
  Schema.Struct({
    ...PreviousInstallRecordFields,
    profile: ProfileNameMigrationSchema,
  }),
  Schema.Struct({
    ...PreviousInstallRecordWithoutProfile,
    plan: ProfileNameMigrationSchema,
  }),
]);

/** Schema for install transaction status values. */
export const InstallTransactionStatusSchema = Schema.Literals(["preparing", "conflicted"]);
/** Schema for install transaction step values. */
export const InstallTransactionStepSchema = Schema.Literals([
  "validated",
  "plugins_snapshotted",
  "roles_prepared",
  "plugins_installed",
  "config_published",
  "verified",
  "conflicted",
]);
/** Schema for install transaction values. */
export const InstallTransactionSchema = Schema.Struct({
  ...InstallRecordSchema.fields,
  status: InstallTransactionStatusSchema,
  step: InstallTransactionStepSchema,
});

const LegacyInstallTransactionFields = {
  ...LegacyInstallRecordFields,
  status: InstallTransactionStatusSchema,
  step: InstallTransactionStepSchema,
} as const;
const LegacyInstallTransactionWithoutProfile = (({ profile: _profile, ...fields }) => fields)(
  LegacyInstallTransactionFields,
);
const PreviousInstallTransactionFields = {
  ...PreviousInstallRecordFields,
  status: InstallTransactionStatusSchema,
  step: InstallTransactionStepSchema,
} as const;
const PreviousInstallTransactionWithoutProfile = (({ profile: _profile, ...fields }) => fields)(
  PreviousInstallTransactionFields,
);
/** Accept prior ownership-record shapes only while decoding persisted transaction journals. */
export const InstallTransactionMigrationSchema = Schema.Union([
  InstallTransactionSchema,
  Schema.Struct({
    ...LegacyInstallTransactionFields,
    profile: ProfileNameMigrationSchema,
  }),
  Schema.Struct({
    ...LegacyInstallTransactionWithoutProfile,
    plan: ProfileNameMigrationSchema,
  }),
  Schema.Struct({
    ...PreviousInstallTransactionFields,
    profile: ProfileNameMigrationSchema,
  }),
  Schema.Struct({
    ...PreviousInstallTransactionWithoutProfile,
    plan: ProfileNameMigrationSchema,
  }),
]);

/** Decode unknown input with an Effect schema, returning undefined on validation failure. */
export function decodeSchema<T>(schema: Schema.Codec<T, unknown>, input: unknown): T | undefined {
  const parsed = decodeUnknown(schema, input);
  return Result.isSuccess(parsed) ? parsed.success : undefined;
}

/** Return whether a value is a string accepted by the JavaScript date parser. */
export function isDateText(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Return whether a value is a JSON object accepted by the CLI boundary schema. */
export function isJsonObject(value: unknown): value is JsonObject {
  return decodeSchema(JsonObjectSchema, value) !== undefined;
}
