// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import {
  decodeUnknown,
  PlanNameSchema,
  ServiceTierSchema,
  STATE_SCHEMA_EPOCH,
  type JsonObject,
} from "@holycodex/core";
import { ManagedRuntimeConfigStateSchema } from "@holycodex/codex";
import { isJsonValue } from "./json.ts";

export const JsonObjectSchema = Schema.declare(
  (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value),
);
export const JsonValueSchema = Schema.declare(isJsonValue);
export const VersionSchema = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
);
export const DigestSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
export const IdentifierSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
);
export const OfficialPluginIdSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u),
);
export const DateTextSchema = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value))),
);
export const ManagedArtifactSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u)),
  digest: DigestSchema,
});

export const OptionalSelectionsSchema = Schema.Struct({
  computer_use: Schema.Boolean,
  work: Schema.Boolean,
  frontend: Schema.Boolean,
  security: Schema.Boolean,
  coding: Schema.Literal(true),
});
export const ExplicitOptionalSelectionsSchema = Schema.Struct({
  computer_use: Schema.optional(Schema.Boolean),
  work: Schema.optional(Schema.Boolean),
  frontend: Schema.optional(Schema.Boolean),
  security: Schema.optional(Schema.Boolean),
});
export const InstallRequestSchema = Schema.Struct({
  plan: Schema.optional(PlanNameSchema),
  tier: Schema.optional(ServiceTierSchema),
  optional: Schema.optional(ExplicitOptionalSelectionsSchema),
  officialPlugins: Schema.optional(Schema.Array(OfficialPluginIdSchema)),
});

export const CapabilityInstallStateSchema = Schema.Struct({
  selected: Schema.Boolean,
  status: Schema.Literal(
    "disabled",
    "pending",
    "healthy",
    "missing",
    "provider_disabled",
    "uncertain",
    "unavailable",
  ),
  plugin_ids: Schema.Array(OfficialPluginIdSchema),
  reason: Schema.optional(Schema.String),
});
export const CapabilityStateRecordSchema = Schema.Struct({
  computer_use: CapabilityInstallStateSchema,
  work: CapabilityInstallStateSchema,
  frontend: CapabilityInstallStateSchema,
  security: CapabilityInstallStateSchema,
});

const PluginConfigEntrySnapshotSchema = Schema.Struct({
  presence: Schema.Literal("absent", "present"),
  digest: DigestSchema,
  safe_value: Schema.optional(
    Schema.Union(
      Schema.Struct({ kind: Schema.Literal("boolean"), value: Schema.Boolean }),
      Schema.Struct({
        kind: Schema.Literal("marketplace"),
        source_type: Schema.Literal("git"),
        source: Schema.Literal("https://github.com/davidbasilefilho/holycodex.git"),
      }),
    ),
  ),
});
export const PluginConfigSnapshotSchema = Schema.Struct({
  plugin_id: Schema.Literal("holycodex@holycodex"),
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
  presence: Schema.Literal("absent", "present"),
  digest: DigestSchema,
  safe_value: Schema.optional(
    Schema.Struct({ kind: Schema.Literal("boolean"), value: Schema.Boolean }),
  ),
});
const ProviderPluginConfigSnapshotSchema = Schema.Struct({
  plugin_id: OfficialPluginIdSchema,
  before: ProviderPluginConfigEntrySnapshotSchema,
  after: ProviderPluginConfigEntrySnapshotSchema,
});

const InstallRecordFields = {
  owner: Schema.Literal("holycodex"),
  schema_epoch: Schema.Literal(STATE_SCHEMA_EPOCH),
  install_id: IdentifierSchema,
  version: VersionSchema,
  digest: DigestSchema,
  plan: PlanNameSchema,
  tier: ServiceTierSchema,
  optional_selections: OptionalSelectionsSchema,
  explicit_optional_selections: ExplicitOptionalSelectionsSchema,
  official_plugins: Schema.optional(Schema.Array(OfficialPluginIdSchema)),
  capability_state: Schema.optional(CapabilityStateRecordSchema),
  managed_artifacts: Schema.Array(ManagedArtifactSchema),
  installed_at: DateTextSchema,
  status: Schema.optional(Schema.Literal("active")),
  step: Schema.optional(Schema.Literal("active")),
  managed_config: Schema.optional(ManagedRuntimeConfigStateSchema),
  plugin_snapshot: Schema.optional(
    Schema.Array(
      Schema.Struct({
        plugin_id: OfficialPluginIdSchema,
        status: Schema.Literal(
          "installed",
          "available",
          "missing",
          "disabled",
          "uncertain",
          "unknown",
        ),
      }),
    ),
  ),
  plugin_config: Schema.optional(PluginConfigSnapshotSchema),
  provider_config: Schema.optional(Schema.Array(ProviderPluginConfigSnapshotSchema)),
  owned_plugins: Schema.optional(Schema.Array(OfficialPluginIdSchema)),
} as const;
export const InstallRecordSchema = Schema.Struct(InstallRecordFields);
export const InstallRecordMigrationSchema = Schema.Struct({
  ...InstallRecordFields,
  plan: Schema.Union(PlanNameSchema, Schema.Literal("Go")),
});

export const InstallTransactionStatusSchema = Schema.Literal("preparing", "conflicted");
export const InstallTransactionStepSchema = Schema.Literal(
  "validated",
  "plugins_snapshotted",
  "roles_prepared",
  "plugins_installed",
  "config_published",
  "verified",
  "conflicted",
);
export const InstallTransactionSchema = Schema.Struct({
  ...InstallRecordSchema.fields,
  status: InstallTransactionStatusSchema,
  step: InstallTransactionStepSchema,
});

export function decodeSchema<T>(schema: Schema.Schema<T>, input: unknown): T | undefined {
  const parsed = decodeUnknown(schema, input);
  return Either.isRight(parsed) ? parsed.right : undefined;
}

export function isDateText(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isJsonObject(value: unknown): value is JsonObject {
  return decodeSchema(JsonObjectSchema, value) !== undefined;
}
