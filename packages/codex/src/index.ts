// SPDX-License-Identifier: Apache-2.0

export {
  CODEX_PROTOCOL_VERSION,
  DEFAULT_MAX_DIAGNOSTIC_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  packageName,
} from "./common";
export { CodexError } from "./common";
export type { CodexErrorCode, CodexResult } from "./common";

export {
  InitializedNotificationSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcErrorSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  SupportedUsageSchema,
  ThreadForkResultSchema,
  ThreadIdentitySchema,
  ThreadListResultSchema,
  ThreadReadResultSchema,
  ThreadResumeResultSchema,
  ThreadStartResultSchema,
  ThreadStartParamsSchema,
  ThreadResumeParamsSchema,
  ThreadReadParamsSchema,
  ThreadListParamsSchema,
  ThreadForkParamsSchema,
  TurnCompletedNotificationSchema,
  TurnInterruptParamsSchema,
  TurnInterruptResultSchema,
  TurnStartParamsSchema,
  TurnStartResultSchema,
  UsageCompletenessSchema,
} from "./protocol";
export type {
  InitializeParams,
  InitializeResult,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcResponse,
  SupportedUsage,
  ThreadForkParams,
  ThreadForkResult,
  ThreadIdentity,
  ThreadListParams,
  ThreadListResult,
  ThreadReadParams,
  ThreadReadResult,
  ThreadResumeParams,
  ThreadResumeResult,
  ThreadStartParams,
  ThreadStartResult,
  TurnCompletedNotification,
  TurnIdentity,
  TurnInterruptParams,
  TurnInterruptResult,
  TurnStartParams,
  TurnStartResult,
  UsageCompleteness,
  CodexNotification,
} from "./protocol";

export { AppServerClient } from "./client";
export type { AppServerClientOptions } from "./client";

export { BunStdioTransport, createAllowlistedEnvironment, sanitizeDiagnostics } from "./transport";
export type { AsyncLineTransport, BunStdioTransportOptions } from "./transport";

export { discoverCodexExecutable, generateCodexSchemas } from "./executable";
export type {
  CodexExecutableDiscoveryOptions,
  CodexExecutableIdentity,
  CommandResult,
  CommandRunner,
  SchemaGenerationOptions,
  SchemaGenerationProvenance,
} from "./executable";

export { createProjectTrustIdentity, ProjectTrustInputSchema } from "./project";
export type { ProjectTrustIdentity, ProjectTrustInput } from "./project";

export {
  cleanupManagedConfig,
  compareBeforeManagedWrite,
  createManagedConfigState,
  ManagedConfigEntrySchema,
  ManagedConfigMetadataSchema,
  mergeManagedConfig,
} from "./managed-config";
export type {
  ManagedConfigCleanup,
  ManagedConfigEntry,
  ManagedConfigMetadata,
  ManagedConfigState,
  ManagedWriteDecision,
} from "./managed-config";

export {
  OfficialPluginManifestSchema,
  OfficialPluginSelectionSchema,
  parseOfficialPluginManifest,
  selectOfficialPlugins,
  verifyOfficialPluginManifest,
  verifyOfficialPluginManifestFile,
} from "./official-plugins";
export type {
  OfficialPluginManifest,
  OfficialPluginSelection,
  OfficialPluginVerification,
} from "./official-plugins";
