// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

import {
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  createManagedRuntimeConfigState,
  ManagedConfigOriginalValueSchema,
  ManagedConfigSafeValueSchema,
  ManagedRuntimeConfigEntrySchema,
  ManagedRuntimeConfigStateSchema,
  mergeManagedRuntimeConfig,
  type ManagedConfigKeyPath,
  type ManagedConfigSafeValue,
  type ManagedRuntimeConfigCleanup,
  type ManagedRuntimeConfigEntry,
  type ManagedRuntimeConfigMerge,
  type ManagedRuntimeConfigState,
  type ManagedConfigWriteValue,
  type TomlDocument,
} from "./runtime-config";

/** Compatibility metadata for callers that previously used this module. */
export const ManagedConfigMetadataSchema = Schema.Struct({
  owner: Schema.Literal("holycodex"),
  schema: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)),
  installId: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)),
});
/** Type of managed config metadata values. */
export type ManagedConfigMetadata = typeof ManagedConfigMetadataSchema.Type;

/** Validates managed config entry values at the Codex boundary. */
export const ManagedConfigEntrySchema = ManagedRuntimeConfigEntrySchema;
/** Type of managed config entry values. */
export type ManagedConfigEntry = ManagedRuntimeConfigEntry;
/** Data contract for managed config state. */
export interface ManagedConfigState extends ManagedRuntimeConfigState {}
/** Data contract for managed config cleanup. */
export interface ManagedConfigCleanup extends ManagedRuntimeConfigCleanup {}

/** Validates managed config state values at the Codex boundary. */
export const ManagedConfigStateSchema = ManagedRuntimeConfigStateSchema;
export { ManagedConfigOriginalValueSchema, ManagedConfigSafeValueSchema };

/** Create a state record containing metadata and safe summaries only. */
export function createManagedConfigState(metadata: ManagedConfigMetadata): ManagedConfigState {
  if (metadata.owner !== "holycodex") throw new Error("Invalid managed config owner.");
  return createManagedRuntimeConfigState(metadata);
}

/** Merge parsed TOML using the safe, per-key runtime-config implementation. */
export async function mergeManagedConfig(
  document: TomlDocument,
  current: ManagedConfigState,
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>,
  metadata: ManagedConfigMetadata,
): Promise<ManagedRuntimeConfigMerge> {
  if (metadata.owner !== "holycodex") throw new Error("Invalid managed config owner.");
  return await mergeManagedRuntimeConfig(document, current, desired, metadata);
}

/** Remove unchanged managed values and preserve drifted or digest-only keys. */
export async function cleanupManagedConfig(
  document: TomlDocument,
  current: ManagedConfigState,
  metadata: ManagedConfigMetadata,
): Promise<ManagedConfigCleanup> {
  if (metadata.owner !== "holycodex") throw new Error("Invalid managed config owner.");
  return await cleanupManagedRuntimeConfig(document, current, metadata);
}

/** Data contract for managed write decision. */
export interface ManagedWriteDecision {
  /** Should write in the managed write decision contract. */
  readonly shouldWrite: boolean;
  /** Current in the managed write decision contract. */
  readonly current?: ManagedConfigSafeValue;
  /** Expected in the managed write decision contract. */
  readonly expected?: ManagedConfigSafeValue;
  /** Next in the managed write decision contract. */
  readonly next: ManagedConfigSafeValue;
}

/** Compare one managed key without returning the underlying value. */
export async function compareBeforeManagedWrite(
  document: TomlDocument,
  current: ManagedConfigState,
  keyPath: ManagedConfigKeyPath,
  next: ManagedConfigSafeValue,
): Promise<ManagedWriteDecision> {
  const comparison = await compareManagedConfigKey(document, current, keyPath);
  return {
    shouldWrite: comparison.status !== "unchanged",
    ...(comparison.current === undefined ? {} : { current: comparison.current }),
    ...(comparison.expected === undefined ? {} : { expected: comparison.expected }),
    next,
  };
}
