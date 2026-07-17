import { handleLspMcpRequest, type JsonRpcResponse } from "@holycodex/lsp-core/mcp";
import { type RequestContext, runWithRequestContext } from "@holycodex/lsp-core/request-context";
import { JsonRpcRequestSchema, McpToolCallParamsSchema } from "@holycodex/mcp-stdio-core/schemas";
import { z } from "zod";

export const CONTEXT_KEY = "_context";
const RequestContextSchema = z
  .strictObject({
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => value.cwd !== undefined || value.env !== undefined);

export interface RoutedRequest {
  input: unknown;
  context: RequestContext | undefined;
}

/** Extracts request context. */
export function extractRequestContext(raw: unknown): RoutedRequest {
  const request = JsonRpcRequestSchema.safeParse(raw);
  if (!request.success || request.data.method !== "tools/call")
    return { input: raw, context: undefined };
  const params = McpToolCallParamsSchema.safeParse(request.data.params);
  if (!params.success) return { input: raw, context: undefined };
  const args = params.data.arguments ?? {};
  const context = parseContext(args[CONTEXT_KEY]);
  if (!context) return { input: raw, context: undefined };

  const cleanedArgs: Record<string, unknown> = { ...args };
  delete cleanedArgs[CONTEXT_KEY];
  const cleaned = {
    ...request.data,
    params: { ...params.data, arguments: cleanedArgs },
  };
  return { input: cleaned, context };
}

/** Handles daemon message. */
export function handleDaemonMessage(raw: unknown): Promise<JsonRpcResponse | undefined> {
  const { input, context } = extractRequestContext(raw);
  if (context) return runWithRequestContext(context, () => handleLspMcpRequest(input));
  return handleLspMcpRequest(input);
}

function parseContext(value: unknown): RequestContext | undefined {
  const parsed = RequestContextSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    ...(parsed.data.cwd === undefined ? {} : { cwd: parsed.data.cwd }),
    ...(parsed.data.env === undefined ? {} : { env: parsed.data.env }),
  };
}
