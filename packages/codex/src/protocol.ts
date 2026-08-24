// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import type { JsonObject, JsonValue } from "@holycodex/core";
import {
  isJsonValue,
  isPlainObject,
  JsonObjectSchema,
  JsonValueSchema,
  NonNegativeNumberSchema,
  TextSchema,
} from "./common";
import {
  GENERATED_APPROVAL_REQUEST_METHODS,
  GENERATED_DYNAMIC_TOOL_REQUEST_METHODS,
  GENERATED_ELICITATION_REQUEST_METHODS,
  GENERATED_PERMISSION_REQUEST_METHODS,
} from "./generated-wire";
import type { v2 as GeneratedV2 } from "../generated/codex-cli-0.148.0/typescript";

const ProtocolMethodSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z][A-Za-z0-9_./:-]{0,127}$/u),
);
export const RequestIdSchema = Schema.Union(
  Schema.String.pipe(Schema.minLength(1)),
  Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value))),
);
export type RequestId = typeof RequestIdSchema.Type;

const JsonRpcErrorObjectSchema = Schema.Struct({
  code: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value))),
  message: Schema.String,
  data: Schema.optional(JsonValueSchema),
});

export const JsonRpcResponseSchema = Schema.Union(
  Schema.Struct({
    id: RequestIdSchema,
    result: JsonValueSchema,
  }),
  Schema.Struct({
    id: RequestIdSchema,
    error: JsonRpcErrorObjectSchema,
  }),
);
export type JsonRpcResponse = typeof JsonRpcResponseSchema.Type;

export const JsonRpcErrorResponseSchema = Schema.Struct({
  id: RequestIdSchema,
  error: JsonRpcErrorObjectSchema,
});
export type JsonRpcErrorResponse = typeof JsonRpcErrorResponseSchema.Type;

export const JsonRpcErrorSchema = JsonRpcErrorObjectSchema;
export type JsonRpcError = typeof JsonRpcErrorSchema.Type;

export const JsonRpcNotificationSchema = Schema.Struct({
  method: ProtocolMethodSchema,
  params: Schema.optional(JsonValueSchema),
});
export type JsonRpcNotification = typeof JsonRpcNotificationSchema.Type;

export const JsonRpcRequestSchema = Schema.Struct({
  id: RequestIdSchema,
  method: ProtocolMethodSchema,
  params: Schema.optional(JsonValueSchema),
  trace: Schema.optional(JsonValueSchema),
});
export type JsonRpcRequest = typeof JsonRpcRequestSchema.Type;

export interface SupportedUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSupportedUsageVariant(
  value: Record<string, unknown>,
  tokenKeys: readonly string[],
  totalKey: string,
): boolean {
  const allowedKeys = new Set([...tokenKeys, totalKey]);
  const presentKeys = Object.keys(value);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }
  return presentKeys.length > 0 && presentKeys.every((key) => isNonNegativeFinite(value[key]));
}

function isSupportedUsage(value: unknown): value is SupportedUsage {
  if (!isPlainObject(value) || !isJsonValue(value)) {
    return false;
  }
  return (
    isSupportedUsageVariant(
      value,
      ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"],
      "totalTokens",
    ) ||
    isSupportedUsageVariant(
      value,
      ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"],
      "total_tokens",
    )
  );
}

export const SupportedUsageSchema = Schema.declare(isSupportedUsage);
export const UsageCompletenessSchema = SupportedUsageSchema;
export type UsageCompleteness = SupportedUsage;

export const InitializeParamsSchema = Schema.Struct({
  clientInfo: Schema.Struct({
    name: TextSchema,
    version: TextSchema,
    title: Schema.Union(TextSchema, Schema.Null),
  }),
  capabilities: Schema.Union(
    Schema.Struct({
      experimentalApi: Schema.Boolean,
      requestAttestation: Schema.Boolean,
      mcpServerOpenaiFormElicitation: Schema.optional(Schema.Boolean),
      optOutNotificationMethods: Schema.optional(
        Schema.Union(Schema.Array(Schema.String), Schema.Null),
      ),
      extensions: Schema.optional(JsonObjectSchema),
    }),
    Schema.Null,
  ),
});
export type InitializeParams = typeof InitializeParamsSchema.Type;

export interface InitializeResult {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
  readonly serverInfo?: JsonObject;
  readonly capabilities?: JsonObject;
  readonly protocolVersion?: string;
}

export const InitializeResultSchema = Schema.declare(
  (value: unknown): value is InitializeResult =>
    isPlainObject(value) &&
    isJsonValue(value) &&
    typeof value["userAgent"] === "string" &&
    typeof value["codexHome"] === "string" &&
    typeof value["platformFamily"] === "string" &&
    typeof value["platformOs"] === "string",
);

export const InitializedNotificationSchema = Schema.Struct({
  method: Schema.Literal("initialized"),
});

export interface ThreadIdentity {
  readonly id: string;
  readonly name?: string;
  readonly preview?: string;
  readonly cwd?: string;
  readonly status?: JsonValue;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly metadata?: JsonObject;
}

function isThreadIdentity(value: unknown): value is ThreadIdentity {
  return (
    isPlainObject(value) &&
    isJsonValue(value) &&
    typeof value["id"] === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value["id"])
  );
}

export const ThreadIdentitySchema = Schema.declare(isThreadIdentity);

function isObjectWithThread(
  value: unknown,
): value is JsonObject & { readonly thread: ThreadIdentity } {
  return isPlainObject(value) && isJsonValue(value) && isThreadIdentity(value["thread"]);
}

function isObjectWithId(value: unknown): value is JsonObject & { readonly id: string } {
  return isPlainObject(value) && isJsonValue(value) && typeof value["id"] === "string";
}

export const ThreadStartResultSchema = Schema.declare(
  (
    value: unknown,
  ): value is JsonObject & { readonly thread?: ThreadIdentity; readonly id?: string } =>
    isObjectWithThread(value) || isObjectWithId(value),
);
export const ThreadResumeResultSchema = ThreadStartResultSchema;
export const ThreadForkResultSchema = ThreadStartResultSchema;
export type ThreadStartResult = typeof ThreadStartResultSchema.Type;
export type ThreadResumeResult = typeof ThreadResumeResultSchema.Type;
export type ThreadForkResult = typeof ThreadForkResultSchema.Type;

export const ThreadUnsubscribeParamsSchema = Schema.declare(hasThreadId);
export type ThreadUnsubscribeParams = typeof ThreadUnsubscribeParamsSchema.Type;

export const ThreadUnsubscribeResultSchema = Schema.declare(
  (
    value: unknown,
  ): value is JsonObject & {
    readonly status: "notLoaded" | "notSubscribed" | "unsubscribed";
  } =>
    isPlainObject(value) &&
    isJsonValue(value) &&
    (value["status"] === "notLoaded" ||
      value["status"] === "notSubscribed" ||
      value["status"] === "unsubscribed"),
);
export type ThreadUnsubscribeResult = typeof ThreadUnsubscribeResultSchema.Type;

export const ThreadReadResultSchema = Schema.declare(
  (value: unknown): value is JsonObject & { readonly thread: ThreadIdentity } =>
    isObjectWithThread(value),
);
export type ThreadReadResult = typeof ThreadReadResultSchema.Type;

export const ThreadListResultSchema = Schema.declare(
  (
    value: unknown,
  ): value is
    | (JsonObject & { readonly data: readonly ThreadIdentity[] })
    | (JsonObject & { readonly threads: readonly ThreadIdentity[] }) => {
    if (!isPlainObject(value) || !isJsonValue(value)) {
      return false;
    }
    const hasData =
      Array.isArray(value["data"]) && value["data"].every((thread) => isThreadIdentity(thread));
    const hasThreads =
      Array.isArray(value["threads"]) &&
      value["threads"].every((thread) => isThreadIdentity(thread));
    return (
      (hasData && value["threads"] === undefined) || (hasThreads && value["data"] === undefined)
    );
  },
);
export type ThreadListResult =
  | (JsonObject & { readonly data: readonly ThreadIdentity[] })
  | (JsonObject & { readonly threads: readonly ThreadIdentity[] });

export const ThreadStartParamsSchema = Schema.declare(
  (value: unknown): value is JsonObject => isPlainObject(value) && isJsonValue(value),
);
export type ThreadStartParams = typeof ThreadStartParamsSchema.Type;

function hasThreadId(value: unknown): value is JsonObject & { readonly threadId: string } {
  return (
    isPlainObject(value) &&
    isJsonValue(value) &&
    typeof value["threadId"] === "string" &&
    value["threadId"].length > 0
  );
}

export const ThreadResumeParamsSchema = Schema.declare(hasThreadId);
export type ThreadResumeParams = typeof ThreadResumeParamsSchema.Type;
export const ThreadReadParamsSchema = Schema.declare(hasThreadId);
export type ThreadReadParams = typeof ThreadReadParamsSchema.Type;
export const ThreadForkParamsSchema = Schema.declare(hasThreadId);
export type ThreadForkParams = typeof ThreadForkParamsSchema.Type;

export const ThreadListParamsSchema = Schema.declare(
  (value: unknown): value is JsonObject => isPlainObject(value) && isJsonValue(value),
);
export type ThreadListParams = typeof ThreadListParamsSchema.Type;

export interface TurnIdentity {
  readonly id: string;
  readonly status?: string;
  readonly usage?: SupportedUsage;
  readonly error?: JsonValue;
}

function isTurnIdentity(value: unknown): value is TurnIdentity {
  return (
    isPlainObject(value) &&
    isJsonValue(value) &&
    typeof value["id"] === "string" &&
    value["id"].length > 0 &&
    (value["usage"] === undefined || isSupportedUsage(value["usage"]))
  );
}

export const TurnStartParamsSchema = Schema.declare(
  (
    value: unknown,
  ): value is JsonObject & {
    readonly threadId: string;
    readonly input?: JsonValue;
    readonly prompt?: string;
  } =>
    hasThreadId(value) &&
    ((Array.isArray(value["input"]) && value["input"].every((item) => isJsonValue(item))) ||
      (typeof value["prompt"] === "string" && value["prompt"].length > 0)),
);
export type TurnStartParams = typeof TurnStartParamsSchema.Type;

export const TurnSteerParamsSchema = Schema.declare(
  (
    value: unknown,
  ): value is JsonObject & { readonly threadId: string; readonly expectedTurnId: string } =>
    hasThreadId(value) &&
    typeof value["expectedTurnId"] === "string" &&
    Array.isArray(value["input"]) &&
    value["input"].every((item) => isJsonValue(item)),
);
export type TurnSteerParams = typeof TurnSteerParamsSchema.Type;

export const TurnStartResultSchema = Schema.declare(
  (
    value: unknown,
  ): value is JsonObject & { readonly turn?: TurnIdentity; readonly turnId?: string } =>
    isPlainObject(value) &&
    isJsonValue(value) &&
    ((value["turn"] !== undefined && isTurnIdentity(value["turn"])) ||
      (typeof value["turnId"] === "string" && value["turnId"].length > 0) ||
      (typeof value["id"] === "string" && value["id"].length > 0)),
);
export type TurnStartResult = typeof TurnStartResultSchema.Type;

export const TurnSteerResultSchema = Schema.declare(
  (value: unknown): value is JsonObject & { readonly turnId: string } =>
    isPlainObject(value) &&
    isJsonValue(value) &&
    typeof value["turnId"] === "string" &&
    value["turnId"].length > 0,
);
export type TurnSteerResult = typeof TurnSteerResultSchema.Type;

export const TurnInterruptParamsSchema = Schema.declare(
  (value: unknown): value is JsonObject & { readonly threadId: string; readonly turnId: string } =>
    hasThreadId(value) && typeof value["turnId"] === "string" && value["turnId"].length > 0,
);
export type TurnInterruptParams = typeof TurnInterruptParamsSchema.Type;

export const TurnInterruptResultSchema = Schema.declare(
  (value: unknown): value is JsonObject => isPlainObject(value) && isJsonValue(value),
);
export type TurnInterruptResult = typeof TurnInterruptResultSchema.Type;

export const TurnCompletedNotificationSchema = Schema.declare(
  (
    value: unknown,
  ): value is JsonObject & {
    readonly threadId: string;
    readonly turn?: TurnIdentity;
    readonly turnId?: string;
  } =>
    hasThreadId(value) &&
    ((value["turn"] !== undefined && isTurnIdentity(value["turn"])) ||
      (typeof value["turnId"] === "string" && value["turnId"].length > 0)),
);
export type TurnCompletedNotification = typeof TurnCompletedNotificationSchema.Type;

export const ModelListParamsSchema = Schema.declare(
  (value: unknown): value is JsonObject => isPlainObject(value) && isJsonValue(value),
);
export type ModelListParams = typeof ModelListParamsSchema.Type;

export interface ModelCapability {
  readonly id: string;
  readonly model: string;
  readonly supportedReasoningEfforts?: readonly JsonObject[];
  readonly serviceTiers?: readonly JsonObject[];
  readonly defaultServiceTier?: string | null;
  readonly multiAgentVersion?: GeneratedV2.MultiAgentVersion | null;
}

function isModelCapability(value: unknown): value is ModelCapability {
  return (
    isPlainObject(value) &&
    isJsonValue(value) &&
    typeof value["id"] === "string" &&
    typeof value["model"] === "string" &&
    (value["supportedReasoningEfforts"] === undefined ||
      (Array.isArray(value["supportedReasoningEfforts"]) &&
        value["supportedReasoningEfforts"].every(
          (entry) => isPlainObject(entry) && typeof entry["reasoningEffort"] === "string",
        ))) &&
    (value["serviceTiers"] === undefined ||
      (Array.isArray(value["serviceTiers"]) &&
        value["serviceTiers"].every(
          (entry) => isPlainObject(entry) && typeof entry["id"] === "string",
        ))) &&
    (value["defaultServiceTier"] === undefined ||
      value["defaultServiceTier"] === null ||
      typeof value["defaultServiceTier"] === "string") &&
    (value["multiAgentVersion"] === undefined ||
      value["multiAgentVersion"] === null ||
      value["multiAgentVersion"] === "disabled" ||
      value["multiAgentVersion"] === "v1" ||
      value["multiAgentVersion"] === "v2")
  );
}

export const ModelListResultSchema = Schema.declare(
  (value: unknown): value is JsonObject & { readonly data: readonly ModelCapability[] } =>
    isPlainObject(value) &&
    isJsonValue(value) &&
    Array.isArray(value["data"]) &&
    value["data"].every((model) => isModelCapability(model)),
);
export type ModelListResult = typeof ModelListResultSchema.Type;

export const ModelProviderCapabilitiesParamsSchema = JsonObjectSchema;
export type ModelProviderCapabilitiesParams = typeof ModelProviderCapabilitiesParamsSchema.Type;
export const ModelProviderCapabilitiesResultSchema = JsonObjectSchema;
export type ModelProviderCapabilitiesResult = typeof ModelProviderCapabilitiesResultSchema.Type;

export const ConfigReadParamsSchema = JsonObjectSchema;
export type ConfigReadParams = typeof ConfigReadParamsSchema.Type;
export const ConfigReadResultSchema = JsonObjectSchema;
export type ConfigReadResult = typeof ConfigReadResultSchema.Type;

export const PermissionProfileListParamsSchema = JsonObjectSchema;
export type PermissionProfileListParams = typeof PermissionProfileListParamsSchema.Type;
export const PermissionProfileListResultSchema = JsonObjectSchema;
export type PermissionProfileListResult = typeof PermissionProfileListResultSchema.Type;

export type ServerRequestCategory =
  | "approval"
  | "dynamic_tool"
  | "elicitation"
  | "other"
  | "permissions";

export interface ServerRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: JsonObject;
  readonly category: ServerRequestCategory;
}

export type ApprovalRequest = ServerRequest & { readonly category: "approval" };
export type PermissionRequest = ServerRequest & { readonly category: "permissions" };
export type ElicitationRequest = ServerRequest & { readonly category: "elicitation" };
export type DynamicToolRequest = ServerRequest & { readonly category: "dynamic_tool" };

export const ServerRequestSchema = Schema.declare(
  (value: unknown): value is ServerRequest =>
    isPlainObject(value) &&
    isJsonValue(value) &&
    (typeof value["id"] === "string" ||
      (typeof value["id"] === "number" && Number.isSafeInteger(value["id"]))) &&
    typeof value["method"] === "string" &&
    isPlainObject(value["params"]) &&
    (value["category"] === "approval" ||
      value["category"] === "dynamic_tool" ||
      value["category"] === "elicitation" ||
      value["category"] === "other" ||
      value["category"] === "permissions"),
);

export const ServerResponseSchema = JsonValueSchema;
export type ServerResponse = typeof ServerResponseSchema.Type;

export interface CodexNotification {
  readonly kind: "multi_agent" | "turn_completed" | "server_request" | "unknown";
  readonly method: string;
  readonly params?: JsonValue;
  readonly metadata?: JsonObject;
}

export const CodexNotificationSchema = Schema.declare(
  (value: unknown): value is CodexNotification =>
    isPlainObject(value) &&
    isJsonValue(value) &&
    typeof value["kind"] === "string" &&
    typeof value["method"] === "string",
);

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

export const CapabilityValueSchema = Schema.Union(
  Schema.Literal("stable", "experimental", "disabled"),
  Schema.Boolean,
);
export const CapabilityMatrixSchema = Schema.Record({
  key: Schema.String,
  value: CapabilityValueSchema,
});
export type CapabilityMatrix = typeof CapabilityMatrixSchema.Type;

// Retained for callers that use the protocol schemas as a type-only namespace.
export { JsonObjectSchema, JsonValueSchema, NonNegativeNumberSchema };
