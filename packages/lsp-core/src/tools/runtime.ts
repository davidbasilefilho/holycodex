import { LSP_MCP_TOOLS } from "./definitions.js";
import { isRecord } from "./parameters.js";
import type { ToolExecutionResult } from "./types.js";

/** Executes lsp tool. */
export async function executeLspTool(
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const tool = LSP_MCP_TOOLS.find(
    (candidate) => candidate.name === name || (candidate.aliases?.includes(name) ?? false),
  );
  if (!tool) throw new Error(`Unknown LSP tool: ${name}`);
  return tool.execute(params, signal);
}

/** Coerces tool arguments. */
export function coerceToolArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
