// SPDX-License-Identifier: Apache-2.0

import { withLspClient } from "../lsp/client-wrapper.ts";
import { DEFAULT_MAX_SYMBOLS } from "../lsp/constants.ts";
import { formatDocumentSymbol, formatSymbolInfo } from "../lsp/formatters.ts";
import { missingDependencyResultOrThrow } from "../missing-dependency-result.ts";
import { optionalNumber, optionalString, requireString } from "./parameters.ts";
import { text } from "./result.ts";
import type { DocumentSymbol, SymbolInfo } from "../lsp/types.ts";
import type { LspSymbolsDetails, ToolExecutionResult } from "./types.ts";

function isDocumentSymbol(value: DocumentSymbol | SymbolInfo): value is DocumentSymbol {
  return "selectionRange" in value;
}
/** Executes document or workspace symbol lookup. */
export async function executeLspSymbols(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const filePath = requireString(params, "filePath");
  const scope = optionalString(params, "scope") === "workspace" ? "workspace" : "document";
  const query = optionalString(params, "query");
  const limit = Math.min(
    Math.max(optionalNumber(params, "limit") ?? DEFAULT_MAX_SYMBOLS, 0),
    DEFAULT_MAX_SYMBOLS,
  );
  if (scope === "workspace" && !query)
    return text("Error: 'query' is required for workspace scope", {
      filePath,
      scope,
      symbols: [],
      totalSymbols: 0,
      truncated: false,
      errorKind: "missing_query",
    });
  try {
    const symbols = [
      ...(await withLspClient(
        filePath,
        (client) =>
          scope === "workspace"
            ? client.workspaceSymbols(query ?? "", signal)
            : client.documentSymbols(filePath, signal),
        scope === "workspace" ? "workspaceSymbols" : "documentSymbols",
        { signal },
      )),
    ];
    const total = symbols.length;
    const shown = symbols.slice(0, limit);
    const details: LspSymbolsDetails = {
      filePath,
      scope,
      ...(query === undefined ? {} : { query }),
      symbols,
      totalSymbols: total,
      truncated: total > limit,
    };
    const lines =
      shown.length === 0
        ? ["No symbols found"]
        : shown.map((symbol) =>
            isDocumentSymbol(symbol) ? formatDocumentSymbol(symbol) : formatSymbolInfo(symbol),
          );
    return text(lines.join("\n"), details);
  } catch (error: unknown) {
    return missingDependencyResultOrThrow(error, {
      filePath,
      scope,
      ...(query === undefined ? {} : { query }),
      symbols: [],
      totalSymbols: 0,
      truncated: false,
    });
  }
}
