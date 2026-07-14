import { messageFromError } from "@holycodex/mcp-stdio-core/responses";

export function reportBestEffortCleanupError(operation: string, error: unknown): void {
  if (process.env["CODEX_LSP_DEBUG_CLEANUP"] !== "1") return;
  const message = messageFromError(error);
  console.error(`[codex-lsp] ignored ${operation} failure during cleanup: ${message}`);
}
