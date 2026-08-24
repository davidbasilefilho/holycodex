// SPDX-License-Identifier: Apache-2.0

import {
  LspServerLookupError,
  LspSetupError,
  LspInvalidPathError,
  LspProcessSpawnError,
} from "./lsp/errors.ts";
import type { ToolExecutionResult } from "./tools/types.ts";

/** Converts unavailable/setup errors into the public structured tool result. */
export function missingDependencyResult<TDetails extends object>(
  error: unknown,
  details: TDetails,
): ToolExecutionResult | null {
  if (
    !(
      error instanceof LspServerLookupError ||
      error instanceof LspSetupError ||
      error instanceof LspInvalidPathError ||
      error instanceof LspProcessSpawnError
    )
  )
    return null;
  const message = error.message;
  return {
    content: [{ type: "text", text: message }],
    details: {
      ...details,
      error: message,
      errorKind: error instanceof LspInvalidPathError ? "invalid_path" : "missing_dependency",
    },
  };
}
/** Returns a structured unavailable result or rethrows an unexpected failure. */
export function missingDependencyResultOrThrow<TDetails extends object>(
  error: unknown,
  details: TDetails,
): ToolExecutionResult {
  const result = missingDependencyResult(error, details);
  if (result !== null) return result;
  throw error;
}
