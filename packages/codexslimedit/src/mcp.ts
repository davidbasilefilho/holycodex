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
import { applyWorkspacePatch } from "./patch.js";
import { CODEX_SLIM_EDIT_VERSION } from "./version.js";
import { editWorkspaceFile, readWorkspaceFile } from "./workspace.js";

const InitializeParamsSchema = z.looseObject({ protocolVersion: z.string() });
const ReadArgumentsSchema = z.strictObject({ filePath: z.string().min(1) });
const ExactEditArgumentsSchema = z.strictObject({
  filePath: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
});
const PatchEnvelopeArgumentsSchema = z.strictObject({ patch: z.string().min(1) });
const ApplyPatchArgumentsSchema = z.union([PatchEnvelopeArgumentsSchema, ExactEditArgumentsSchema]);
const READ_FILE_TOOL_NAME = "read_file";
const APPLY_PATCH_TOOL_NAME = "apply_patch";

/** Options for the CodexSlimEdit MCP server. */
export interface CodexSlimEditMcpOptions {
  /** Workspace root; defaults to the server process current directory. */
  readonly root?: string;
  /** Explicit filesystem capability; defaults to read-only workspace access. */
  readonly accessMode?: "read-only" | "workspace-write" | "full-access";
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
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
    name: READ_FILE_TOOL_NAME,
    description:
      "Required tool for reading one complete UTF-8 workspace file. Returns the workspace-relative path and exact content without metadata or footer boilerplate.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The workspace-relative path of the file to read.",
        },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: APPLY_PATCH_TOOL_NAME,
    description:
      "Required workspace write tool. Use a native `*** Begin Patch` envelope to add, update, or delete files; for a smaller single replacement, pass filePath, oldString, and newString.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "Native Codex patch envelope with Add File, Update File, or Delete File operations.",
        },
        filePath: {
          type: "string",
          description: "The workspace-relative path for a compact single-file replacement.",
        },
        oldString: {
          type: "string",
          description:
            "The unique exact text, or inclusive 1-based line number or N-M range to replace.",
        },
        newString: { type: "string", description: "Replacement text; may be empty." },
      },
      oneOf: [{ required: ["patch"] }, { required: ["filePath", "oldString", "newString"] }],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
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
  const accessMode = options.accessMode ?? "read-only";
  if (name === READ_FILE_TOOL_NAME) {
    const parsed = ReadArgumentsSchema.safeParse(arguments_);
    if (!parsed.success)
      return toolResponse(id, `${READ_FILE_TOOL_NAME}.filePath must be a non-empty string.`, true);
    return operationResponse(
      id,
      () =>
        readWorkspaceFile({
          root,
          ...parsed.data,
          allowOutsideRoot: accessMode === "full-access",
        }),
      (result) => `${result.path}\n${result.content}`,
    );
  }
  if (name === APPLY_PATCH_TOOL_NAME) {
    if (accessMode === "read-only")
      return toolResponse(
        id,
        "WRITE_ACCESS_DENIED: apply_patch requires workspace-write or full-access permission.",
        true,
      );
    const parsed = ApplyPatchArgumentsSchema.safeParse(arguments_);
    if (!parsed.success)
      return toolResponse(
        id,
        `${APPLY_PATCH_TOOL_NAME} requires a non-empty patch envelope or non-empty filePath and oldString plus string newString.`,
        true,
      );
    const parsedArguments = parsed.data;
    if ("patch" in parsedArguments) {
      const patch = parsedArguments.patch;
      return operationResponse(
        id,
        () => applyWorkspacePatch({ root, patch }),
        () => "Done!",
      );
    }
    return operationResponse(
      id,
      () => editWorkspaceFile({ root, ...parsedArguments }),
      (result) => `OK ${result.path}`,
    );
  }
  return toolResponse(id, `Unknown codexslimedit tool: ${name}`, true);
}

async function operationResponse<Result>(
  id: string | number | null,
  operation: () => Promise<Result>,
  successText: (result: Result) => string,
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
