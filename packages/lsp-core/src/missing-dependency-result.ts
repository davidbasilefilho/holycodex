import { handleMissingDependencyError } from "./lsp/startup-failure.js";
import type { ToolExecutionResult } from "./tools.js";

/** Provides missing dependency result. */
export function missingDependencyResult<TDetails extends object>(
  error: unknown,
  details: TDetails,
): ToolExecutionResult | null {
  const message = handleMissingDependencyError(error);
  if (!message) return null;

  return {
    content: [{ type: "text", text: message }],
    details: {
      ...details,
      error: message,
      errorKind: "missing_dependency",
    },
  };
}

/** Provides missing dependency result or throw. */
export function missingDependencyResultOrThrow<TDetails extends object>(
  error: unknown,
  details: TDetails,
): ToolExecutionResult {
  const result = missingDependencyResult(error, details);
  if (result !== null) return result;
  throw error;
}
