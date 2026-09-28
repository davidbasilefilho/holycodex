// SPDX-License-Identifier: Apache-2.0

// The generated bindings are the transport-edge authority. Domain schemas in protocol.ts
// intentionally map their untrusted values to smaller HolyCodex-owned types.
import type {
  ClientNotification,
  ClientRequest,
  ServerNotification,
  ServerRequest,
} from "../generated/typescript";

export type {
  ClientNotification as GeneratedClientNotification,
  ClientRequest as GeneratedClientRequest,
  ServerNotification as GeneratedServerNotification,
  ServerRequest as GeneratedServerRequest,
} from "../generated/typescript";

/** Method names accepted by the generated client request union. */
export type GeneratedClientRequestMethod = ClientRequest["method"];
/** Method names accepted by the generated server request union. */
export type GeneratedServerRequestMethod = ServerRequest["method"];
/** Method names accepted by the generated server notification union. */
export type GeneratedServerNotificationMethod = ServerNotification["method"];
/** Method names accepted by the generated client notification union. */
export type GeneratedClientNotificationMethod = ClientNotification["method"];

// Keep this list deliberately narrow: each entry is a supported App Server seam and is
// checked against the generated request union so a new or misspelled RPC cannot compile.
/** App Server methods implemented by the HolyCodex client. */
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

/** Server-initiated request methods recognized by the App Server adapter. */
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

/** Server request methods that require an approval response. */
export const GENERATED_APPROVAL_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
] as const satisfies readonly GeneratedServerRequestMethod[];

/** Server request methods that require a permission response. */
export const GENERATED_PERMISSION_REQUEST_METHODS = [
  "item/permissions/requestApproval",
] as const satisfies readonly GeneratedServerRequestMethod[];

/** Server request methods that elicit information from the client. */
export const GENERATED_ELICITATION_REQUEST_METHODS = [
  "mcpServer/elicitation/request",
] as const satisfies readonly GeneratedServerRequestMethod[];

/** Server request methods that invoke a dynamic tool. */
export const GENERATED_DYNAMIC_TOOL_REQUEST_METHODS = [
  "item/tool/call",
] as const satisfies readonly GeneratedServerRequestMethod[];

/** Client notification sent after the App Server handshake completes. */
export const GENERATED_INITIALIZED_NOTIFICATION = {
  method: "initialized",
} satisfies ClientNotification;

/** Method name of the notification emitted when a turn completes. */
export const GENERATED_TURN_COMPLETED_NOTIFICATION_METHOD =
  "turn/completed" satisfies GeneratedServerNotificationMethod;

// A distinct V2 lifecycle needs a generated client request surface for agent/collaboration
// control. The generated request union has no such method; its V2 files describe model and
// item data only. The conditional type intentionally turns a future generated lifecycle
// addition into a compile-time reminder to add the corresponding lifecycle adapter.
type GeneratedV2LifecycleRequest = Extract<
  ClientRequest,
  { method: `${string}agent${string}` | `${string}collab${string}` }
>;
/** Verification status for V2 lifecycle methods in generated client bindings. */
export type GeneratedMultiAgentV2LifecycleStatus = GeneratedV2LifecycleRequest extends never
  ? "verified" | "unverified"
  : never;
/** Current verification result for the generated V2 lifecycle surface. */
export const GENERATED_MULTI_AGENT_V2_LIFECYCLE_STATUS: GeneratedMultiAgentV2LifecycleStatus =
  "unverified";

/** Report whether the generated wire surface exposes a V2 multi-agent lifecycle request. */
export function generatedMultiAgentV2LifecycleStatus(): GeneratedMultiAgentV2LifecycleStatus {
  return GENERATED_MULTI_AGENT_V2_LIFECYCLE_STATUS;
}
