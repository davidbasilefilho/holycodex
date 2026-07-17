import type { Readable, Writable } from "node:stream";

import { handleLspMcpRequest, type JsonRpcId, type JsonRpcResponse } from "@holycodex/lsp-core/mcp";
import {
  JsonRpcRequestSchema,
  jsonRpcId,
  McpToolCallParamsSchema,
  messageFromError,
  runJsonRpcStdioServer,
  successResponse,
} from "@holycodex/mcp-stdio-core";

import {
  type CallToolOptions,
  callToolViaDaemon,
  currentRequestContext,
  type DaemonToolContext,
} from "./daemon-client.js";
import { type DaemonPaths, daemonPaths } from "./paths.js";

export interface ProxyOptions {
  input?: Readable;
  output?: Writable;
  paths?: DaemonPaths;
  context?: DaemonToolContext;
  ensure?: CallToolOptions["ensure"];
}

interface ToolCall {
  id: JsonRpcId;
  name: string;
  args: Record<string, unknown>;
}

/** Runs mcp stdio proxy. */
export async function runMcpStdioProxy(options: ProxyOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const paths = options.paths ?? daemonPaths();
  const context = options.context ?? currentRequestContext();
  const callOptions: CallToolOptions = {
    paths,
    context,
    ...(options.ensure ? { ensure: options.ensure } : {}),
  };

  await runJsonRpcStdioServer({
    input,
    output,
    idleTimeoutMs: 0,
    handler: handleProxyRequest,
    handlerOptions: callOptions,
    onHandlerError: (error: unknown) => {
      process.stderr.write(`[lsp-daemon] proxy error: ${messageFromError(error)}\n`);
    },
  });
}

async function handleProxyRequest(
  parsed: unknown,
  callOptions: CallToolOptions,
): Promise<JsonRpcResponse | undefined> {
  const toolCall = asToolCall(parsed);
  if (!toolCall) return handleLspMcpRequest(parsed);

  const result = await callToolViaDaemon(toolCall.name, toolCall.args, callOptions);
  return successResponse(toolCall.id, {
    content: result.content,
    isError: result.isError ?? false,
    details: result.details,
  });
}

function asToolCall(parsed: unknown): ToolCall | null {
  const request = JsonRpcRequestSchema.safeParse(parsed);
  if (!request.success || request.data.method !== "tools/call") return null;
  const params = McpToolCallParamsSchema.safeParse(request.data.params);
  if (!params.success) return null;
  return {
    id: jsonRpcId(request.data.id),
    name: params.data.name,
    args: params.data.arguments ?? {},
  };
}
