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
import { isJsonValue } from "./json.ts";

export const JsonObjectSchema = Schema.declare(
  (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value),
);

export const JsonValueSchema = Schema.declare(isJsonValue);
export const VersionSchema = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
);
export const EpochSchema = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9._:-]{0,63}$/u));
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
export const ArtifactIdSchema = Schema.String.pipe(
  Schema.pattern(/^artifact-[0-9a-f]{64}-[a-z][a-z0-9._:-]{0,63}$/u),
);
export const AutonomySchema = Schema.Literal("manual", "assisted", "autonomous");
export const RelativeArtifactPathSchema = Schema.String.pipe(
  Schema.pattern(/^\.\/plugins\/holycodex\/artifact-[0-9a-f]{64}-[a-z][a-z0-9._:-]{0,63}$/u),
);

export const OptionalSelectionsSchema = Schema.Struct({
  computer_use: Schema.Boolean,
  work: Schema.Boolean,
  web: Schema.Boolean,
  security: Schema.Boolean,
  coding: Schema.Literal(true),
});
export const ExplicitOptionalSelectionsSchema = Schema.Struct({
  computer_use: Schema.optional(Schema.Boolean),
  work: Schema.optional(Schema.Boolean),
  web: Schema.optional(Schema.Boolean),
  security: Schema.optional(Schema.Boolean),
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
  web: CapabilityInstallStateSchema,
  security: CapabilityInstallStateSchema,
});

export const InstallRecordSchema = Schema.Struct({
  schema_epoch: Schema.Literal(STATE_SCHEMA_EPOCH),
  version: VersionSchema,
  digest: DigestSchema,
  plan: PlanNameSchema,
  tier: ServiceTierSchema,
  optional_selections: OptionalSelectionsSchema,
  explicit_optional_selections: ExplicitOptionalSelectionsSchema,
  official_plugins: Schema.optional(Schema.Array(OfficialPluginIdSchema)),
  capability_state: Schema.optional(CapabilityStateRecordSchema),
  autonomy: Schema.optional(AutonomySchema),
  max_subagents: Schema.optional(
    Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value > 0)),
  ),
  installed_at: DateTextSchema,
});

export const LockMetadataSchema = Schema.Struct({
  owner_pid: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value > 0)),
  run_id: IdentifierSchema,
  started_at: DateTextSchema,
  expires_at: Schema.Number.pipe(Schema.filter((value) => Number.isFinite(value) && value > 0)),
});

export const SchemaEpochRecordSchema = Schema.Struct({
  schema_epoch: Schema.String.pipe(Schema.minLength(1)),
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
