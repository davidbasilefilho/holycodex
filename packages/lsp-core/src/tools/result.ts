import type { ToolExecutionResult } from "./types.js";

/** Creates a text tool result. */
export function text(text: string, details?: unknown, isError = false): ToolExecutionResult {
  return { content: [{ type: "text", text }], details, isError };
}
