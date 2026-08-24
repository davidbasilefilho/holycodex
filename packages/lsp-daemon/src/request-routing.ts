// SPDX-License-Identifier: Apache-2.0

import { runWithRequestContext, type RequestContext } from "@holycodex/lsp-core/request-context";
import { executeLspTool, type ToolExecutionResult } from "@holycodex/lsp-core/tools";
import { decodeLspSchema, JsonObjectSchema } from "@holycodex/lsp-core";
import * as Schema from "effect/Schema";

export const CONTEXT_KEY = "_context";
const RequestSchema = Schema.Struct({
  id: Schema.Union(Schema.String, Schema.Number),
  method: Schema.Literal("lsp/call"),
  params: Schema.Struct({
    command: Schema.String,
    arguments: Schema.optional(JsonObjectSchema),
    auth: Schema.optional(Schema.String),
  }),
});
const ContextSchema = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
const ToolResultSchema = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  isError: Schema.optional(Schema.Boolean),
  details: Schema.optional(Schema.Unknown),
});

export type DaemonResponse = { readonly id: string | number; readonly result: ToolExecutionResult };
export interface RoutedRequest {
  readonly input: unknown;
  readonly context: RequestContext | undefined;
  readonly auth: string | undefined;
}
export interface RequestRoutingOptions {
  readonly execute?: (
    command: string,
    args: Record<string, unknown>,
  ) => Promise<ToolExecutionResult>;
  readonly nonce?: string;
}

/** Validates and removes the reserved per-request context field. */
export function extractRequestContext(raw: unknown): RoutedRequest {
  const request = decodeLspSchema(RequestSchema, raw);
  if (request === undefined) return { input: raw, context: undefined, auth: undefined };
  const args = request.params.arguments ?? {};
  const rawContext = args[CONTEXT_KEY];
  const context = decodeLspSchema(ContextSchema, rawContext);
  const cleanedArgs: Record<string, import("@holycodex/lsp-core").JsonValue> = { ...args };
  delete cleanedArgs[CONTEXT_KEY];
  return {
    input: { ...request, params: { ...request.params, arguments: cleanedArgs } },
    context: context === undefined ? undefined : context,
    auth: request.params.auth,
  };
}

/** Validates, authenticates, scopes, and executes one daemon request. */
export async function handleDaemonMessage(
  raw: unknown,
  options: RequestRoutingOptions = {},
): Promise<DaemonResponse | undefined> {
  const routed = extractRequestContext(raw);
  const request = decodeLspSchema(RequestSchema, routed.input);
  if (request === undefined || (options.nonce !== undefined && routed.auth !== options.nonce))
    return undefined;
  const args = request.params.arguments ?? {};
  const execute =
    options.execute ??
    ((command: string, input: Record<string, unknown>) => executeLspTool(command, input));
  const result =
    routed.context === undefined
      ? await execute(request.params.command, args)
      : await runWithRequestContext(routed.context, () => execute(request.params.command, args));
  const validated = decodeLspSchema(ToolResultSchema, result);
  if (validated === undefined) return undefined;
  return { id: request.id, result };
}
