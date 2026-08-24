// SPDX-License-Identifier: Apache-2.0

import type { ToolExecutionResult } from "./types.ts";
/** Creates a bounded text tool result. */
export function text(value: string, details?: unknown, isError = false): ToolExecutionResult {
  return {
    content: [{ type: "text", text: value }],
    ...(details === undefined ? {} : { details }),
    ...(isError ? { isError: true } : {}),
  };
}
