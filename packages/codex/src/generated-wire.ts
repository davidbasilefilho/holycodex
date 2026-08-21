// SPDX-License-Identifier: Apache-2.0

// The generated bindings are the transport-edge authority. Domain schemas in protocol.ts
// intentionally map their untrusted values to smaller HolyCodex-owned types.
import type {
  ClientNotification,
  ClientRequest,
  ServerNotification,
  ServerRequest,
} from "../generated/codex-cli-0.148.0/typescript";

export type {
  ClientNotification as GeneratedClientNotification,
  ClientRequest as GeneratedClientRequest,
  ServerNotification as GeneratedServerNotification,
  ServerRequest as GeneratedServerRequest,
} from "../generated/codex-cli-0.148.0/typescript";

export type GeneratedClientRequestMethod = ClientRequest["method"];
export type GeneratedServerRequestMethod = ServerRequest["method"];
export type GeneratedServerNotificationMethod = ServerNotification["method"];
export type GeneratedClientNotificationMethod = ClientNotification["method"];

// Keep this list deliberately narrow: each entry is a supported App Server seam and is
// checked against the generated request union so a new or misspelled RPC cannot compile.
export const GENERATED_SUPPORTED_CLIENT_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/list",
  "thread/fork",
  "thread/unsubscribe",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "model/list",
  "modelProvider/capabilities/read",
  "config/read",
  "permissionProfile/list",
] as const satisfies readonly GeneratedClientRequestMethod[];

export const GENERATED_SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "applyPatchApproval",
  "execCommandApproval",
] as const satisfies readonly GeneratedServerRequestMethod[];

export const GENERATED_APPROVAL_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
] as const satisfies readonly GeneratedServerRequestMethod[];

export const GENERATED_PERMISSION_REQUEST_METHODS = [
  "item/permissions/requestApproval",
] as const satisfies readonly GeneratedServerRequestMethod[];

export const GENERATED_ELICITATION_REQUEST_METHODS = [
  "mcpServer/elicitation/request",
] as const satisfies readonly GeneratedServerRequestMethod[];

export const GENERATED_DYNAMIC_TOOL_REQUEST_METHODS = [
  "item/tool/call",
] as const satisfies readonly GeneratedServerRequestMethod[];

export const GENERATED_INITIALIZED_NOTIFICATION = {
  method: "initialized",
} satisfies ClientNotification;

export const GENERATED_TURN_COMPLETED_NOTIFICATION_METHOD =
  "turn/completed" satisfies GeneratedServerNotificationMethod;

// A distinct V2 lifecycle needs a generated client request surface for agent/collaboration
// control. The 0.148.0 request union has no such method; its V2 files describe model and
// item data only. The conditional type intentionally turns a future generated lifecycle
// addition into a compile-time reminder to add the corresponding lifecycle adapter.
type GeneratedV2LifecycleRequest = Extract<
  ClientRequest,
  { method: `${string}agent${string}` | `${string}collab${string}` }
>;
export type GeneratedMultiAgentV2LifecycleStatus = GeneratedV2LifecycleRequest extends never
  ? "verified" | "unverified"
  : never;
export const GENERATED_MULTI_AGENT_V2_LIFECYCLE_STATUS: GeneratedMultiAgentV2LifecycleStatus =
  "unverified";

export function generatedMultiAgentV2LifecycleStatus(): GeneratedMultiAgentV2LifecycleStatus {
  return GENERATED_MULTI_AGENT_V2_LIFECYCLE_STATUS;
}
