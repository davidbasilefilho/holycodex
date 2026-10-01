// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonValue } from "@holycodex/core";
import * as Schema from "effect/Schema";

import type { v2 as GeneratedV2 } from "../generated/typescript";
import { JsonObjectSchema, JsonValueSchema, NonNegativeNumberSchema, TextSchema } from "./common";
import {
  GENERATED_APPROVAL_REQUEST_METHODS,
  GENERATED_DYNAMIC_TOOL_REQUEST_METHODS,
  GENERATED_ELICITATION_REQUEST_METHODS,
  GENERATED_PERMISSION_REQUEST_METHODS,
} from "./generated-wire";
import { TomlDocumentSchema } from "./runtime-config";

const ProtocolMethodSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_./:-]{0,127}$/u),
);
const JsonObjectRest = [Schema.Record(Schema.String, JsonValueSchema)] as const;
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u));
const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
/** Validates request id values at the Codex boundary. */
export const RequestIdSchema = Schema.Union([
  Schema.String.check(Schema.isMinLength(1)),
  Schema.Number.check(Schema.makeFilter((value) => Number.isSafeInteger(value))),
]);
/** String or numeric identifier used to correlate a JSON-RPC request and response. */
export type RequestId = typeof RequestIdSchema.Type;

const JsonRpcErrorObjectSchema = Schema.Struct({
  code: Schema.Number.check(Schema.makeFilter((value) => Number.isSafeInteger(value))),
  message: Schema.String,
  data: Schema.optional(JsonValueSchema),
});

/** Validates json rpc response values at the Codex boundary. */
export const JsonRpcResponseSchema = Schema.Union([
  Schema.Struct({
    id: RequestIdSchema,
    result: JsonValueSchema,
  }),
  Schema.Struct({
    id: RequestIdSchema,
    error: JsonRpcErrorObjectSchema,
  }),
]);
/** Successful JSON-RPC result or structured JSON-RPC error response. */
export type JsonRpcResponse = typeof JsonRpcResponseSchema.Type;

/** Validates json rpc error response values at the Codex boundary. */
export const JsonRpcErrorResponseSchema = Schema.Struct({
  id: RequestIdSchema,
  error: JsonRpcErrorObjectSchema,
});
/** JSON-RPC response containing a structured error. */
export type JsonRpcErrorResponse = typeof JsonRpcErrorResponseSchema.Type;

/** Validates json rpc error values at the Codex boundary. */
export const JsonRpcErrorSchema = JsonRpcErrorObjectSchema;
/** Standard code, message, and optional data for a JSON-RPC error. */
export type JsonRpcError = typeof JsonRpcErrorSchema.Type;

/** Validates json rpc notification values at the Codex boundary. */
export const JsonRpcNotificationSchema = Schema.Struct({
  method: ProtocolMethodSchema,
  params: Schema.optional(JsonValueSchema),
});
/** JSON-RPC notification that does not expect a response. */
export type JsonRpcNotification = typeof JsonRpcNotificationSchema.Type;

/** Validates json rpc request values at the Codex boundary. */
export const JsonRpcRequestSchema = Schema.Struct({
  id: RequestIdSchema,
  method: ProtocolMethodSchema,
  params: Schema.optional(JsonValueSchema),
  trace: Schema.optional(JsonValueSchema),
});
/** JSON-RPC request with an identifier, method, and optional parameters. */
export type JsonRpcRequest = typeof JsonRpcRequestSchema.Type;

/** Data contract for supported usage. */
export interface SupportedUsage {
  /** Number of input tokens consumed. */
  readonly inputTokens?: number;
  /** Number of input tokens served from cache. */
  readonly cachedInputTokens?: number;
  /** Number of output tokens generated. */
  readonly outputTokens?: number;
  /** Number of reasoning tokens generated. */
  readonly reasoningOutputTokens?: number;
  /** Total number of tokens consumed. */
  readonly totalTokens?: number;
  /** Number of input tokens consumed. */
  readonly input_tokens?: number;
  /** Number of input tokens served from cache. */
  readonly cached_input_tokens?: number;
  /** Number of output tokens generated. */
  readonly output_tokens?: number;
  /** Number of reasoning tokens generated. */
  readonly reasoning_output_tokens?: number;
  /** Total number of tokens consumed. */
  readonly total_tokens?: number;
}

const UsageCountSchema = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const CamelCaseUsageSchema = Schema.Struct({
  inputTokens: Schema.optionalKey(UsageCountSchema),
  cachedInputTokens: Schema.optionalKey(UsageCountSchema),
  outputTokens: Schema.optionalKey(UsageCountSchema),
  reasoningOutputTokens: Schema.optionalKey(UsageCountSchema),
  totalTokens: Schema.optionalKey(UsageCountSchema),
}).check(Schema.makeFilter((value) => Object.values(value).some((count) => count !== undefined)));
const SnakeCaseUsageSchema = Schema.Struct({
  input_tokens: Schema.optionalKey(UsageCountSchema),
  cached_input_tokens: Schema.optionalKey(UsageCountSchema),
  output_tokens: Schema.optionalKey(UsageCountSchema),
  reasoning_output_tokens: Schema.optionalKey(UsageCountSchema),
  total_tokens: Schema.optionalKey(UsageCountSchema),
}).check(Schema.makeFilter((value) => Object.values(value).some((count) => count !== undefined)));

/** Validates supported usage values at the Codex boundary. */
export const SupportedUsageSchema: Schema.Codec<SupportedUsage, unknown> = Schema.Union([
  CamelCaseUsageSchema,
  SnakeCaseUsageSchema,
]);
/** Validates usage completeness values at the Codex boundary. */
export const UsageCompletenessSchema = SupportedUsageSchema;
/** Token usage counters attached to a Codex turn. */
export type UsageCompleteness = SupportedUsage;

/** Validates initialize params values at the Codex boundary. */
export const InitializeParamsSchema = Schema.Struct({
  clientInfo: Schema.Struct({
    name: TextSchema,
    version: TextSchema,
    title: Schema.Union([TextSchema, Schema.Null]),
  }),
  capabilities: Schema.Union([
    Schema.Struct({
      experimentalApi: Schema.Boolean,
      requestAttestation: Schema.Boolean,
      mcpServerOpenaiFormElicitation: Schema.optional(Schema.Boolean),
      optOutNotificationMethods: Schema.optional(
        Schema.Union([Schema.Array(Schema.String), Schema.Null]),
      ),
      extensions: Schema.optional(JsonObjectSchema),
    }),
    Schema.Null,
  ]),
});
/** Parameters accepted by the initialize operation. */
export type InitializeParams = typeof InitializeParamsSchema.Type;

/** Result returned by the initialize operation. */
export interface InitializeResult {
  /** User agent in the initialize result contract. */
  readonly userAgent: string;
  /** Codex home directory used by the server. */
  readonly codexHome: string;
  /** Platform family in the initialize result contract. */
  readonly platformFamily: string;
  /** Platform os in the initialize result contract. */
  readonly platformOs: string;
  /** Identity and version information for the server. */
  readonly serverInfo?: JsonObject;
  /** Capabilities negotiated with the server. */
  readonly capabilities?: JsonObject;
  /** Protocol version negotiated with the server. */
  readonly protocolVersion?: string;
}

/** Validates initialize result values at the Codex boundary. */
export const InitializeResultSchema = Schema.StructWithRest(
  Schema.Struct({
    userAgent: Schema.String,
    codexHome: Schema.String,
    platformFamily: Schema.String,
    platformOs: Schema.String,
    serverInfo: Schema.optionalKey(JsonObjectSchema),
    capabilities: Schema.optionalKey(JsonObjectSchema),
    protocolVersion: Schema.optionalKey(Schema.String),
  }),
  JsonObjectRest,
);

/** Validates initialized notification values at the Codex boundary. */
export const InitializedNotificationSchema = Schema.Struct({
  method: Schema.Literals(["initialized"]),
});

/** Stable identity and display metadata for a Codex conversation thread. */
export interface ThreadIdentity {
  /** Request or entity identifier. */
  readonly id: string;
  /** Human-readable name of the entity. */
  readonly name?: string;
  /** Short preview of the thread content. */
  readonly preview?: string;
  /** Working directory used to resolve relative paths. */
  readonly cwd?: string;
  /** Current lifecycle status of the entity. */
  readonly status?: JsonValue;
  /** Created at in the thread identity contract. */
  readonly createdAt?: number;
  /** Updated at in the thread identity contract. */
  readonly updatedAt?: number;
  /** Validated metadata associated with the entity. */
  readonly metadata?: JsonObject;
}

/** Validates thread identity values at the Codex boundary. */
export const ThreadIdentitySchema = Schema.StructWithRest(
  Schema.Struct({ id: Identifier }),
  JsonObjectRest,
);

/** Validates thread start result values at the Codex boundary. */
export const ThreadStartResultSchema = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({ thread: ThreadIdentitySchema, id: Schema.optionalKey(Schema.String) }),
    JsonObjectRest,
  ),
  Schema.StructWithRest(Schema.Struct({ id: Schema.String }), JsonObjectRest),
]);
/** Validates thread resume result values at the Codex boundary. */
export const ThreadResumeResultSchema = ThreadStartResultSchema;
/** Validates thread fork result values at the Codex boundary. */
export const ThreadForkResultSchema = ThreadStartResultSchema;
/** Result returned by the thread start operation. */
export type ThreadStartResult = typeof ThreadStartResultSchema.Type;
/** Result returned by the thread resume operation. */
export type ThreadResumeResult = typeof ThreadResumeResultSchema.Type;
/** Result returned by the thread fork operation. */
export type ThreadForkResult = typeof ThreadForkResultSchema.Type;

/** Validates thread unsubscribe params values at the Codex boundary. */
export const ThreadUnsubscribeParamsSchema = Schema.StructWithRest(
  Schema.Struct({ threadId: NonEmptyString }),
  JsonObjectRest,
);
/** Parameters accepted by the thread unsubscribe operation. */
export type ThreadUnsubscribeParams = typeof ThreadUnsubscribeParamsSchema.Type;

/** Validates thread unsubscribe result values at the Codex boundary. */
export const ThreadUnsubscribeResultSchema = Schema.StructWithRest(
  Schema.Struct({ status: Schema.Literals(["notLoaded", "notSubscribed", "unsubscribed"]) }),
  JsonObjectRest,
);
/** Result returned by the thread unsubscribe operation. */
export type ThreadUnsubscribeResult = typeof ThreadUnsubscribeResultSchema.Type;

/** Validates thread read result values at the Codex boundary. */
export const ThreadReadResultSchema = Schema.StructWithRest(
  Schema.Struct({ thread: ThreadIdentitySchema }),
  JsonObjectRest,
);
/** Result returned by the thread read operation. */
export type ThreadReadResult = typeof ThreadReadResultSchema.Type;

/** Validates thread list result values at the Codex boundary. */
export const ThreadListResultSchema: Schema.Codec<ThreadListResult, unknown> =
  JsonObjectSchema.check(
    Schema.makeFilter(
      (value) =>
        (Array.isArray(value["data"]) &&
          value["threads"] === undefined &&
          Schema.is(Schema.Array(ThreadIdentitySchema))(value["data"])) ||
        (Array.isArray(value["threads"]) &&
          value["data"] === undefined &&
          Schema.is(Schema.Array(ThreadIdentitySchema))(value["threads"])),
    ),
  ) as Schema.Codec<ThreadListResult, unknown>;
/** Result returned by the thread list operation. */
export type ThreadListResult =
  | (JsonObject & { readonly data: readonly ThreadIdentity[] })
  | (JsonObject & { readonly threads: readonly ThreadIdentity[] });

/** Validates thread start params values at the Codex boundary. */
export const ThreadStartParamsSchema = JsonObjectSchema;
/** Parameters accepted by the thread start operation. */
export type ThreadStartParams = typeof ThreadStartParamsSchema.Type;

/** Validates thread resume params values at the Codex boundary. */
export const ThreadResumeParamsSchema = Schema.StructWithRest(
  Schema.Struct({ threadId: NonEmptyString }),
  JsonObjectRest,
);
/** Parameters accepted by the thread resume operation. */
export type ThreadResumeParams = typeof ThreadResumeParamsSchema.Type;
/** Validates thread read params values at the Codex boundary. */
export const ThreadReadParamsSchema = ThreadResumeParamsSchema;
/** Parameters accepted by the thread read operation. */
export type ThreadReadParams = typeof ThreadReadParamsSchema.Type;
/** Validates thread fork params values at the Codex boundary. */
export const ThreadForkParamsSchema = ThreadResumeParamsSchema;
/** Parameters accepted by the thread fork operation. */
export type ThreadForkParams = typeof ThreadForkParamsSchema.Type;

/** Validates thread list params values at the Codex boundary. */
export const ThreadListParamsSchema = JsonObjectSchema;
/** Parameters accepted by the thread list operation. */
export type ThreadListParams = typeof ThreadListParamsSchema.Type;

/** Data contract for turn identity. */
export interface TurnIdentity {
  /** Request or entity identifier. */
  readonly id: string;
  /** Current lifecycle status of the entity. */
  readonly status?: string;
  /** Usage in the turn identity contract. */
  readonly usage?: SupportedUsage;
  /** Structured error returned by the operation. */
  readonly error?: JsonValue;
}

const TurnIdentitySchema = Schema.StructWithRest(
  Schema.Struct({
    id: NonEmptyString,
    status: Schema.optionalKey(Schema.String),
    usage: Schema.optionalKey(SupportedUsageSchema),
    error: Schema.optionalKey(JsonValueSchema),
  }),
  JsonObjectRest,
);

/** Validates turn start params values at the Codex boundary. */
export const TurnStartParamsSchema = JsonObjectSchema.check(
  Schema.makeFilter(
    (value) =>
      typeof value["threadId"] === "string" &&
      value["threadId"].length > 0 &&
      ((Array.isArray(value["input"]) &&
        Schema.is(Schema.Array(JsonValueSchema))(value["input"])) ||
        (typeof value["prompt"] === "string" && value["prompt"].length > 0)),
  ),
);
/** Parameters accepted by the turn start operation. */
export type TurnStartParams = typeof TurnStartParamsSchema.Type;

/** Validates turn steer params values at the Codex boundary. */
export const TurnSteerParamsSchema = JsonObjectSchema.check(
  Schema.makeFilter(
    (value) =>
      typeof value["threadId"] === "string" &&
      value["threadId"].length > 0 &&
      typeof value["expectedTurnId"] === "string" &&
      value["expectedTurnId"].length > 0 &&
      Array.isArray(value["input"]) &&
      Schema.is(Schema.Array(JsonValueSchema))(value["input"]),
  ),
);
/** Parameters accepted by the turn steer operation. */
export type TurnSteerParams = typeof TurnSteerParamsSchema.Type;

/** Validates turn start result values at the Codex boundary. */
export const TurnStartResultSchema = JsonObjectSchema.check(
  Schema.makeFilter(
    (value) =>
      (value["turn"] !== undefined && Schema.is(TurnIdentitySchema)(value["turn"])) ||
      (typeof value["turnId"] === "string" && value["turnId"].length > 0) ||
      (typeof value["id"] === "string" && value["id"].length > 0),
  ),
);
/** Result returned by the turn start operation. */
export type TurnStartResult = typeof TurnStartResultSchema.Type;

/** Validates turn steer result values at the Codex boundary. */
export const TurnSteerResultSchema = JsonObjectSchema.check(
  Schema.makeFilter((value) => typeof value["turnId"] === "string" && value["turnId"].length > 0),
);
/** Result returned by the turn steer operation. */
export type TurnSteerResult = typeof TurnSteerResultSchema.Type;

/** Validates turn interrupt params values at the Codex boundary. */
export const TurnInterruptParamsSchema = JsonObjectSchema.check(
  Schema.makeFilter(
    (value) =>
      typeof value["threadId"] === "string" &&
      value["threadId"].length > 0 &&
      typeof value["turnId"] === "string" &&
      value["turnId"].length > 0,
  ),
);
/** Parameters accepted by the turn interrupt operation. */
export type TurnInterruptParams = typeof TurnInterruptParamsSchema.Type;

/** Validates turn interrupt result values at the Codex boundary. */
export const TurnInterruptResultSchema = JsonObjectSchema;
/** Result returned by the turn interrupt operation. */
export type TurnInterruptResult = typeof TurnInterruptResultSchema.Type;

/** Validates turn completed notification values at the Codex boundary. */
export const TurnCompletedNotificationSchema = JsonObjectSchema.check(
  Schema.makeFilter(
    (value) =>
      typeof value["threadId"] === "string" &&
      value["threadId"].length > 0 &&
      ((value["turn"] !== undefined && Schema.is(TurnIdentitySchema)(value["turn"])) ||
        (typeof value["turnId"] === "string" && value["turnId"].length > 0)),
  ),
);
/** Type of turn completed notification values. */
export type TurnCompletedNotification = typeof TurnCompletedNotificationSchema.Type;

/** Validates model list params values at the Codex boundary. */
export const ModelListParamsSchema = JsonObjectSchema;
/** Parameters accepted by the model list operation. */
export type ModelListParams = typeof ModelListParamsSchema.Type;

/** Data contract for model capability. */
export interface ModelCapability {
  /** Request or entity identifier. */
  readonly id: string;
  /** Model in the model capability contract. */
  readonly model: string;
  /** Supported reasoning efforts in the model capability contract. */
  readonly supportedReasoningEfforts?: readonly JsonObject[];
  /** Service tiers in the model capability contract. */
  readonly serviceTiers?: readonly JsonObject[];
  /** Default service tier in the model capability contract. */
  readonly defaultServiceTier?: string | null;
  /** Multi agent version in the model capability contract. */
  readonly multiAgentVersion?: GeneratedV2.MultiAgentVersion | null;
}

const ModelReasoningEffortSchema = Schema.StructWithRest(
  Schema.Struct({ reasoningEffort: Schema.String }),
  JsonObjectRest,
);
const ModelServiceTierSchema = Schema.StructWithRest(
  Schema.Struct({ id: Schema.String }),
  JsonObjectRest,
);
const ModelCapabilitySchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    model: Schema.String,
    supportedReasoningEfforts: Schema.optionalKey(Schema.Array(ModelReasoningEffortSchema)),
    serviceTiers: Schema.optionalKey(Schema.Array(ModelServiceTierSchema)),
    defaultServiceTier: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    multiAgentVersion: Schema.optionalKey(
      Schema.Union([Schema.Literals(["disabled", "v1", "v2"]), Schema.Null]),
    ),
  }),
  JsonObjectRest,
);

/** Validates model list result values at the Codex boundary. */
export const ModelListResultSchema = Schema.StructWithRest(
  Schema.Struct({ data: Schema.Array(ModelCapabilitySchema) }),
  JsonObjectRest,
);
/** Result returned by the model list operation. */
export type ModelListResult = typeof ModelListResultSchema.Type;

/** Validates model provider capabilities params values at the Codex boundary. */
export const ModelProviderCapabilitiesParamsSchema = JsonObjectSchema;
/** Parameters accepted by the model provider capabilities operation. */
export type ModelProviderCapabilitiesParams = typeof ModelProviderCapabilitiesParamsSchema.Type;
/** Validates model provider capabilities result values at the Codex boundary. */
export const ModelProviderCapabilitiesResultSchema = JsonObjectSchema;
/** Result returned by the model provider capabilities operation. */
export type ModelProviderCapabilitiesResult = typeof ModelProviderCapabilitiesResultSchema.Type;

/** Validates config read params values at the Codex boundary. */
export const ConfigReadParamsSchema = Schema.Struct({
  includeLayers: Schema.optional(Schema.Boolean),
  cwd: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});
/** Parameters accepted by the config read operation. */
export type ConfigReadParams = typeof ConfigReadParamsSchema.Type;
/** Validates config read result values at the Codex boundary. */
export const ConfigReadResultSchema = Schema.Struct({
  config: TomlDocumentSchema,
  origins: JsonObjectSchema,
  layers: Schema.Union([Schema.Array(JsonObjectSchema), Schema.Null]),
});
/** Result returned by the config read operation. */
export type ConfigReadResult = typeof ConfigReadResultSchema.Type;

/** Validates permission profile list params values at the Codex boundary. */
export const PermissionProfileListParamsSchema = JsonObjectSchema;
/** Parameters accepted by the permission profile list operation. */
export type PermissionProfileListParams = typeof PermissionProfileListParamsSchema.Type;
/** Validates permission profile list result values at the Codex boundary. */
export const PermissionProfileListResultSchema = JsonObjectSchema;
/** Result returned by the permission profile list operation. */
export type PermissionProfileListResult = typeof PermissionProfileListResultSchema.Type;

/** Interaction category used to route an App Server request. */
export type ServerRequestCategory =
  | "approval"
  | "dynamic_tool"
  | "elicitation"
  | "other"
  | "permissions";

/** Data contract for server request. */
export interface ServerRequest {
  /** Request or entity identifier. */
  readonly id: RequestId;
  /** JSON-RPC method name. */
  readonly method: string;
  /** Parameters supplied to the operation. */
  readonly params: JsonObject;
  /** Category in the server request contract. */
  readonly category: ServerRequestCategory;
}

/** Server request that requires user approval. */
export type ApprovalRequest = ServerRequest & { readonly category: "approval" };
/** Server request that changes or checks permissions. */
export type PermissionRequest = ServerRequest & { readonly category: "permissions" };
/** Server request asking the client to elicit information. */
export type ElicitationRequest = ServerRequest & { readonly category: "elicitation" };
/** Server request that invokes a dynamic tool. */
export type DynamicToolRequest = ServerRequest & { readonly category: "dynamic_tool" };

/** Validates server request values at the Codex boundary. */
export const ServerRequestSchema = Schema.StructWithRest(
  Schema.Struct({
    id: RequestIdSchema,
    method: Schema.String,
    params: JsonObjectSchema,
    category: Schema.Literals(["approval", "dynamic_tool", "elicitation", "other", "permissions"]),
  }),
  JsonObjectRest,
);

/** Validates server response values at the Codex boundary. */
export const ServerResponseSchema = JsonValueSchema;
/** Type of server response values. */
export type ServerResponse = typeof ServerResponseSchema.Type;

/** Data contract for codex notification. */
export interface CodexNotification {
  /** Kind in the codex notification contract. */
  readonly kind: "multi_agent" | "turn_completed" | "server_request" | "unknown";
  /** JSON-RPC method name. */
  readonly method: string;
  /** Parameters supplied to the operation. */
  readonly params?: JsonValue;
  /** Validated metadata associated with the entity. */
  readonly metadata?: JsonObject;
}

/** Validates codex notification values at the Codex boundary. */
export const CodexNotificationSchema = Schema.StructWithRest(
  Schema.Struct({
    kind: Schema.Literals(["multi_agent", "turn_completed", "server_request", "unknown"]),
    method: Schema.String,
    params: Schema.optionalKey(JsonValueSchema),
    metadata: Schema.optionalKey(JsonObjectSchema),
  }),
  JsonObjectRest,
);

/** Classify a server request method by its interaction category. */
export function classifyServerRequest(method: string): ServerRequestCategory {
  if (GENERATED_PERMISSION_REQUEST_METHODS.some((candidate) => candidate === method)) {
    return "permissions";
  }
  if (GENERATED_APPROVAL_REQUEST_METHODS.some((candidate) => candidate === method)) {
    return "approval";
  }
  if (GENERATED_ELICITATION_REQUEST_METHODS.some((candidate) => candidate === method)) {
    return "elicitation";
  }
  if (GENERATED_DYNAMIC_TOOL_REQUEST_METHODS.some((candidate) => candidate === method)) {
    return "dynamic_tool";
  }
  return "other";
}

/** Validates capability value values at the Codex boundary. */
export const CapabilityValueSchema = Schema.Union([
  Schema.Literals(["stable", "experimental", "disabled"]),
  Schema.Boolean,
]);
/** Validates capability matrix values at the Codex boundary. */
export const CapabilityMatrixSchema = Schema.Record(Schema.String, CapabilityValueSchema);
/** Type of capability matrix values. */
export type CapabilityMatrix = typeof CapabilityMatrixSchema.Type;

// Retained for callers that use the protocol schemas as a type-only namespace.
export { JsonObjectSchema, JsonValueSchema, NonNegativeNumberSchema };
