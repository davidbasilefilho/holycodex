import type { Readable, Writable } from "node:stream";

import {
  errorResponse,
  JsonRpcRequestSchema,
  McpToolCallParamsSchema,
  jsonRpcId,
  messageFromError,
  runJsonRpcStdioServer,
  successResponse,
} from "@holycodex/mcp-stdio-core";
import type { JsonRpcResponse } from "@holycodex/mcp-stdio-core";
import { z } from "zod";

import { WorkspaceFileError } from "./errors.js";
import { CODEX_SLIM_EDIT_VERSION } from "./version.js";
import { editWorkspaceFile, readWorkspaceFile } from "./workspace.js";

const InitializeParamsSchema = z.looseObject({ protocolVersion: z.string() });
const ReadArgumentsSchema = z.strictObject({ filePath: z.string().min(1) });
const EditArgumentsSchema = z.strictObject({
  filePath: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
});

/** Options for the CodexSlimEdit MCP server. */
export interface CodexSlimEditMcpOptions {
  /** Workspace root; defaults to the server process current directory. */
  readonly root?: string;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Handles one CodexSlimEdit MCP JSON-RPC request. */
export async function handleCodexSlimEditMcpRequest(
  input: unknown,
  options: CodexSlimEditMcpOptions = {},
): Promise<JsonRpcResponse | undefined> {
  const request = JsonRpcRequestSchema.safeParse(input);
  if (!request.success) return errorResponse(null, -32600, "Invalid Request");
  const id = jsonRpcId(request.data.id);
  if (request.data.method === "initialize") {
    const protocolVersion =
      InitializeParamsSchema.safeParse(request.data.params).data?.protocolVersion ?? "2024-11-05";
    return successResponse(id, {
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "codexslimedit", version: CODEX_SLIM_EDIT_VERSION },
      protocolVersion,
    });
  }
  if (request.data.method === "tools/list") return successResponse(id, { tools: TOOL_DEFINITIONS });
  if (request.data.method === "tools/call") {
    const params = McpToolCallParamsSchema.safeParse(request.data.params);
    if (!params.success) return toolResponse(id, "Invalid tools/call parameters.", true);
    return await callTool(id, params.data.name, params.data.arguments ?? {}, options);
  }
  if (request.data.method === "notifications/initialized") return undefined;
  return errorResponse(id, -32601, "Method not found");
}

/** Runs the CodexSlimEdit MCP server over stdio. */
export async function runCodexSlimEditMcpStdioServer(
  input: Readable,
  output: Writable,
  options: CodexSlimEditMcpOptions = {},
): Promise<void> {
  await runJsonRpcStdioServer({
    input,
    output,
    handler: handleCodexSlimEditMcpRequest,
    handlerOptions: options,
    idleTimeoutMs: 0,
  });
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read",
    description: "Read one UTF-8 workspace file concisely.",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description: "Atomically replace unique content or an inclusive line range.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["filePath", "oldString", "newString"],
      additionalProperties: false,
    },
  },
];

async function callTool(
  id: string | number | null,
  name: string,
  arguments_: Record<string, unknown>,
  options: CodexSlimEditMcpOptions,
): Promise<JsonRpcResponse> {
  const root = options.root ?? process.cwd();
  if (name === "read") {
    const parsed = ReadArgumentsSchema.safeParse(arguments_);
    if (!parsed.success) return toolResponse(id, "read.filePath must be a non-empty string.", true);
    return fileOperationResponse(
      id,
      () => readWorkspaceFile({ root, ...parsed.data }),
      (result) => `${result.path}\n${result.content}`,
    );
  }
  if (name === "edit") {
    const parsed = EditArgumentsSchema.safeParse(arguments_);
    if (!parsed.success)
      return toolResponse(
        id,
        "edit requires non-empty filePath and oldString plus string newString.",
        true,
      );
    return fileOperationResponse(
      id,
      () => editWorkspaceFile({ root, ...parsed.data }),
      (result) => `OK ${result.path}`,
    );
  }
  return toolResponse(id, `Unknown codexslimedit tool: ${name}`, true);
}

async function fileOperationResponse(
  id: string | number | null,
  operation: () => Promise<{ readonly path: string; readonly content: string }>,
  successText: (result: { readonly path: string; readonly content: string }) => string,
): Promise<JsonRpcResponse> {
  try {
    const result = await operation();
    return toolResponse(id, successText(result));
  } catch (error) {
    const message =
      error instanceof WorkspaceFileError
        ? `${error.code}: ${error.message}`
        : messageFromError(error);
    return toolResponse(id, message, true);
  }
}

function toolResponse(id: string | number | null, text: string, isError = false): JsonRpcResponse {
  return successResponse(id, { content: [{ type: "text", text }], isError });
}
