// SPDX-License-Identifier: Apache-2.0

export {
  DEFAULT_SCHEMA_EPOCH as defaultSchemaEpoch,
  PAYLOAD_MANIFEST_PATH as payloadManifestPath,
  SOURCE_MANIFEST_PATH as sourceManifestPath,
  packageName,
  pluginSourceRoot,
} from "./constants.ts";
export { PluginError } from "./errors.ts";
export type { PluginErrorCode } from "./errors.ts";
export {
  GeneratedManifestSchema,
  GeneratedPluginManifestSchema,
  PayloadIdentitySchema,
  PayloadManifestSchema,
  SourceManifestSchema,
  SourcePluginManifestSchema,
} from "./schemas.ts";
export type {
  ArtifactIdentity,
  AssemblyPlan,
  AssemblyRequest,
  AssembledPayload,
  GeneratedManifest,
  GeneratedPluginManifest,
  PayloadFile,
  PayloadIdentity,
  PayloadManifest,
  SourceFile,
  SourceManifest,
  SourceValidation,
  VerifiedPayload,
} from "./types.ts";
export { validateSource, planAssembly } from "./planning.ts";
export { assemblePayload } from "./assembly.ts";
export { verifyPayload } from "./verification.ts";
