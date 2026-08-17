// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import type { JsonObject } from "@holycodex/core";
import {
  IdentifierSchema,
  isPlainObject,
  JsonObjectSchema,
  JsonValueSchema,
  NonNegativeNumberSchema,
  TextSchema,
} from "./common";

const ProtocolMethodSchema = type(/^[A-Za-z][A-Za-z0-9_./:-]{0,127}$/u);
const RequestIdSchema = type("number").narrow(
  (value): value is number => Number.isSafeInteger(value) && value >= 0,
);
const ResponseIdSchema = RequestIdSchema.or("null");

const JsonRpcErrorObjectSchema = type({
  "+": "delete",
  code: type("number").narrow((value): value is number => Number.isSafeInteger(value)),
  message: TextSchema,
  "data?": JsonValueSchema,
});

export const JsonRpcResponseSchema = type({
  "+": "delete",
  jsonrpc: "'2.0'",
  id: ResponseIdSchema,
  result: JsonValueSchema,
  "error?": "never",
}).or(
  type({
    "+": "delete",
    jsonrpc: "'2.0'",
    id: ResponseIdSchema,
    error: JsonRpcErrorObjectSchema,
    "result?": "never",
  }),
);
export type JsonRpcResponse = typeof JsonRpcResponseSchema.infer;

export const JsonRpcErrorResponseSchema = type({
  "+": "delete",
  jsonrpc: "'2.0'",
  id: ResponseIdSchema,
  error: JsonRpcErrorObjectSchema,
  "result?": "never",
});
export type JsonRpcErrorResponse = typeof JsonRpcErrorResponseSchema.infer;

export const JsonRpcErrorSchema = JsonRpcErrorObjectSchema;
export type JsonRpcError = typeof JsonRpcErrorSchema.infer;

export const JsonRpcNotificationSchema = type({
  "+": "delete",
  jsonrpc: "'2.0'",
  method: ProtocolMethodSchema,
  "params?": JsonValueSchema,
  "id?": "never",
});
export type JsonRpcNotification = typeof JsonRpcNotificationSchema.infer;

export const JsonRpcRequestSchema = type({
  "+": "delete",
  jsonrpc: "'2.0'",
  id: RequestIdSchema,
  method: ProtocolMethodSchema,
  "params?": JsonValueSchema,
});

const UsageCamelSchema = type({
  "+": "delete",
  inputTokens: NonNegativeNumberSchema,
  cachedInputTokens: NonNegativeNumberSchema,
  outputTokens: NonNegativeNumberSchema,
  reasoningOutputTokens: NonNegativeNumberSchema,
  "totalTokens?": NonNegativeNumberSchema,
  "input_tokens?": "never",
  "cached_input_tokens?": "never",
  "output_tokens?": "never",
  "reasoning_output_tokens?": "never",
  "total_tokens?": "never",
});
const UsageSnakeSchema = type({
  "+": "delete",
  input_tokens: NonNegativeNumberSchema,
  cached_input_tokens: NonNegativeNumberSchema,
  output_tokens: NonNegativeNumberSchema,
  reasoning_output_tokens: NonNegativeNumberSchema,
  "total_tokens?": NonNegativeNumberSchema,
  "inputTokens?": "never",
  "cachedInputTokens?": "never",
  "outputTokens?": "never",
  "reasoningOutputTokens?": "never",
  "totalTokens?": "never",
});

export const SupportedUsageSchema = UsageCamelSchema.or(UsageSnakeSchema);
export type SupportedUsage = typeof SupportedUsageSchema.infer;
export const UsageCompletenessSchema = SupportedUsageSchema;
export type UsageCompleteness = SupportedUsage;

const ClientInfoSchema = type({
  "+": "delete",
  name: IdentifierSchema,
  version: TextSchema,
  "title?": TextSchema,
});

export const InitializeParamsSchema = type({
  "+": "delete",
  clientInfo: ClientInfoSchema,
  "capabilities?": JsonObjectSchema,
});
export type InitializeParams = typeof InitializeParamsSchema.infer;

const ServerInfoSchema = type({
  "+": "delete",
  "name?": TextSchema,
  "version?": TextSchema,
});

export const InitializeResultSchema = type({
  "+": "delete",
  "serverInfo?": ServerInfoSchema,
  "capabilities?": JsonObjectSchema,
  "protocolVersion?": TextSchema,
});
export type InitializeResult = typeof InitializeResultSchema.infer;

export const InitializedNotificationSchema = type({
  "+": "reject",
  jsonrpc: "'2.0'",
  method: "'initialized'",
});

const ThreadIdSchema = IdentifierSchema;
const ThreadIdentitySchema = type({
  "+": "delete",
  id: ThreadIdSchema,
  "name?": TextSchema,
  "preview?": type("string"),
  "cwd?": TextSchema,
  "status?": JsonValueSchema,
  "createdAt?": NonNegativeNumberSchema,
  "updatedAt?": NonNegativeNumberSchema,
  "metadata?": JsonObjectSchema,
});
export { ThreadIdentitySchema };
export type ThreadIdentity = typeof ThreadIdentitySchema.infer;

const ThreadEnvelopeSchema = type({
  "+": "delete",
  thread: ThreadIdentitySchema,
  "id?": "never",
});
const DirectThreadResultSchema = type({
  "+": "delete",
  id: ThreadIdSchema,
  "thread?": "never",
  "name?": TextSchema,
  "preview?": type("string"),
  "cwd?": TextSchema,
  "status?": JsonValueSchema,
  "createdAt?": NonNegativeNumberSchema,
  "updatedAt?": NonNegativeNumberSchema,
  "metadata?": JsonObjectSchema,
});

export const ThreadStartResultSchema = ThreadEnvelopeSchema.or(DirectThreadResultSchema);
export const ThreadResumeResultSchema = ThreadStartResultSchema;
export const ThreadForkResultSchema = ThreadStartResultSchema;
export type ThreadStartResult = typeof ThreadStartResultSchema.infer;
export type ThreadResumeResult = typeof ThreadResumeResultSchema.infer;
export type ThreadForkResult = typeof ThreadForkResultSchema.infer;

export const ThreadReadResultSchema = type({
  "+": "delete",
  thread: ThreadIdentitySchema,
  "turns?": JsonValueSchema,
  "items?": JsonValueSchema,
  "messages?": JsonValueSchema,
});
export type ThreadReadResult = typeof ThreadReadResultSchema.infer;

const ThreadListFields = {
  "+": "delete",
  "nextCursor?": type("string | null"),
} as const;
export const ThreadListResultSchema = type({
  ...ThreadListFields,
  data: ThreadIdentitySchema.array(),
  "threads?": "never",
}).or(
  type({
    ...ThreadListFields,
    threads: ThreadIdentitySchema.array(),
    "data?": "never",
  }),
);
export type ThreadListResult = typeof ThreadListResultSchema.infer;

export const ThreadStartParamsSchema = type({
  "+": "delete",
  "cwd?": TextSchema,
  "approvalPolicy?": JsonValueSchema,
  "sandboxPolicy?": JsonValueSchema,
  "model?": TextSchema,
  "ephemeral?": "boolean",
  "config?": JsonObjectSchema,
});
export type ThreadStartParams = typeof ThreadStartParamsSchema.infer;

export const ThreadResumeParamsSchema = type({
  "+": "delete",
  threadId: ThreadIdSchema,
  "cwd?": TextSchema,
  "approvalPolicy?": JsonValueSchema,
  "sandboxPolicy?": JsonValueSchema,
  "config?": JsonObjectSchema,
});
export type ThreadResumeParams = typeof ThreadResumeParamsSchema.infer;

export const ThreadReadParamsSchema = type({
  "+": "delete",
  threadId: ThreadIdSchema,
});
export type ThreadReadParams = typeof ThreadReadParamsSchema.infer;

export const ThreadListParamsSchema = type({
  "+": "delete",
  "cursor?": type("string | null"),
  "limit?": NonNegativeNumberSchema,
});
export type ThreadListParams = typeof ThreadListParamsSchema.infer;

export const ThreadForkParamsSchema = type({
  "+": "delete",
  threadId: ThreadIdSchema,
  "cwd?": TextSchema,
  "approvalPolicy?": JsonValueSchema,
  "sandboxPolicy?": JsonValueSchema,
});
export type ThreadForkParams = typeof ThreadForkParamsSchema.infer;

const TurnStatusSchema = TextSchema;
const TurnIdentitySchema = type({
  "+": "delete",
  id: IdentifierSchema,
  "status?": TurnStatusSchema,
  "usage?": SupportedUsageSchema,
  "error?": JsonValueSchema,
});
export type TurnIdentity = typeof TurnIdentitySchema.infer;

const TurnStartParamsBaseSchema = type({
  "+": "delete",
  threadId: ThreadIdSchema,
  "input?": JsonValueSchema,
  "prompt?": TextSchema,
  "approvalPolicy?": JsonValueSchema,
  "sandboxPolicy?": JsonValueSchema,
  "model?": TextSchema,
  "effort?": TextSchema,
  "reasoningEffort?": TextSchema,
  "serviceTier?": TextSchema,
  "cwd?": TextSchema,
});
export const TurnStartParamsSchema = TurnStartParamsBaseSchema.narrow(
  (value): value is typeof TurnStartParamsBaseSchema.infer =>
    isPlainObject(value) && ("input" in value || "prompt" in value),
);
export type TurnStartParams = typeof TurnStartParamsSchema.infer;

export const TurnStartResultSchema = type({
  "+": "delete",
  turn: TurnIdentitySchema,
  "turnId?": "never",
  "id?": "never",
})
  .or(
    type({
      "+": "delete",
      turnId: IdentifierSchema,
      "turn?": "never",
      "id?": "never",
    }),
  )
  .or(
    type({
      "+": "delete",
      id: IdentifierSchema,
      "turn?": "never",
      "turnId?": "never",
      "status?": TurnStatusSchema,
      "usage?": SupportedUsageSchema,
      "error?": JsonValueSchema,
    }),
  );
export type TurnStartResult = typeof TurnStartResultSchema.infer;

export const TurnInterruptParamsSchema = type({
  "+": "reject",
  threadId: ThreadIdSchema,
  turnId: IdentifierSchema,
});
export type TurnInterruptParams = typeof TurnInterruptParamsSchema.infer;

export const TurnInterruptResultSchema = type({
  "+": "delete",
  "ok?": "boolean",
  "turnId?": IdentifierSchema,
});
export type TurnInterruptResult = typeof TurnInterruptResultSchema.infer;

const TurnCompletedDirectSchema = type({
  "+": "delete",
  threadId: ThreadIdSchema,
  turnId: IdentifierSchema,
  "turn?": "never",
  "status?": TurnStatusSchema,
  "usage?": SupportedUsageSchema,
  "error?": JsonValueSchema,
});
const TurnCompletedEnvelopeSchema = type({
  "+": "delete",
  threadId: ThreadIdSchema,
  turn: TurnIdentitySchema,
  "turnId?": "never",
  "usage?": SupportedUsageSchema,
  "error?": JsonValueSchema,
});
export const TurnCompletedNotificationSchema = TurnCompletedDirectSchema.or(
  TurnCompletedEnvelopeSchema,
);
export type TurnCompletedNotification = typeof TurnCompletedNotificationSchema.infer;

export type CodexNotification =
  | {
      readonly kind: "turn_completed";
      readonly method: "turn/completed";
      readonly params: TurnCompletedNotification;
    }
  | {
      readonly kind: "unknown";
      readonly method: string;
      readonly metadata: JsonObject;
    };
