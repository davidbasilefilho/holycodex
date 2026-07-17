import type { Readable, Writable } from "node:stream";

import {
  errorResponse,
  JsonRpcRequestSchema,
  jsonRpcId,
  McpToolCallParamsSchema,
  messageFromError,
  runJsonRpcStdioServer,
  successResponse,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcResponse,
  type JsonRpcResult,
  type McpToolDescriptor,
} from "@holycodex/mcp-stdio-core";
import { z } from "zod";

import { VERSION } from "../../cli/src/catalog.ts";
import { coerceToolArguments, executeLspTool, LSP_MCP_TOOLS } from "./tools.js";

export type { JsonRpcError, JsonRpcId, JsonRpcResponse, JsonRpcResult, McpToolDescriptor };

const SERVER_NAME = "lsp";
const SERVER_VERSION = VERSION;
const InitializeParamsSchema = z.looseObject({ protocolVersion: z.string() });

/** Handles lsp mcp request. */
export async function handleLspMcpRequest(input: unknown): Promise<JsonRpcResponse | undefined> {
  const request = JsonRpcRequestSchema.safeParse(input);
  if (!request.success) {
    return errorResponse(null, -32600, "Invalid Request");
  }

  const id = jsonRpcId(request.data.id);
  const method = request.data.method;
  if (method === "notifications/initialized") return undefined;
  if (method === "ping") return successResponse(id, {});
  if (method === "initialize") {
    const protocolVersion = requestedProtocolVersion(request.data.params);
    return successResponse(id, {
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      protocolVersion,
    });
  }

  if (method === "tools/list") {
    return successResponse(id, { tools: LSP_MCP_TOOLS.map(describeTool) });
  }

  if (method === "tools/call") {
    return handleToolCall(id, request.data.params);
  }

  return errorResponse(id, -32601, `Method not found: ${String(method)}`);
}

/** Runs mcp stdio server. */
export async function runMcpStdioServer(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  await runJsonRpcStdioServer({
    input,
    output,
    idleTimeoutMs: 0,
    handler: handleLspMcpRequest,
    handlerOptions: undefined,
  });
}

async function handleToolCall(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
  const toolCall = McpToolCallParamsSchema.safeParse(params);
  if (!toolCall.success) {
    return errorResponse(id, -32602, "tools/call requires params.name");
  }

  try {
    const result = await executeLspTool(
      toolCall.data.name,
      coerceToolArguments(toolCall.data.arguments),
    );
    return successResponse(id, {
      content: result.content,
      isError: result.isError ?? false,
      details: result.details,
    });
  } catch (error) {
    return successResponse(id, {
      content: [{ type: "text", text: messageFromError(error) }],
      isError: true,
    });
  }
}

function describeTool(tool: (typeof LSP_MCP_TOOLS)[number]): McpToolDescriptor {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function requestedProtocolVersion(params: unknown): string {
  return InitializeParamsSchema.safeParse(params).data?.protocolVersion ?? "2024-11-05";
}
