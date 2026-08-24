// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";
import { SEVERITY_MAP, SYMBOL_KIND_MAP } from "./language-mappings.ts";
import type {
  Diagnostic,
  DocumentSymbol,
  Location,
  LocationLink,
  PrepareRenameDefaultBehavior,
  PrepareRenameResult,
  Range,
  SeverityFilter,
  SymbolInfo,
} from "./types.ts";
import type { ApplyResult } from "./workspace-edit.ts";

/** Converts a file URI to a local path. */
export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}
export function formatLocation(location: Location | LocationLink): string {
  const target =
    "targetUri" in location ? { uri: location.targetUri, range: location.targetRange } : location;
  return `${uriToPath(target.uri)}:${target.range.start.line + 1}:${target.range.start.character}`;
}
export function formatSymbolKind(kind: number): string {
  return SYMBOL_KIND_MAP[kind] ?? `Unknown(${kind})`;
}
export function formatSeverity(severity: number | undefined): string {
  return severity === undefined ? "unknown" : (SEVERITY_MAP[severity] ?? `unknown(${severity})`);
}
export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string {
  const line = `${"  ".repeat(indent)}${symbol.name} (${formatSymbolKind(symbol.kind)}) - line ${symbol.range.start.line + 1}`;
  return [
    line,
    ...(symbol.children ?? []).map((child) => formatDocumentSymbol(child, indent + 1)),
  ].join("\n");
}
export function formatSymbolInfo(symbol: SymbolInfo): string {
  return `${symbol.name} (${formatSymbolKind(symbol.kind)})${symbol.containerName ? ` (in ${symbol.containerName})` : ""} - ${formatLocation(symbol.location)}`;
}
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${formatSeverity(diagnostic.severity)}${diagnostic.source ? ` [${diagnostic.source}]` : ""}${diagnostic.code === undefined ? "" : ` (${diagnostic.code})`} at ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character}: ${diagnostic.message}`;
}
export function filterDiagnosticsBySeverity(
  diagnostics: readonly Diagnostic[],
  severity: SeverityFilter = "all",
): Diagnostic[] {
  return severity === "all"
    ? [...diagnostics]
    : diagnostics.filter(
        (item) =>
          item.severity === ({ error: 1, warning: 2, information: 3, hint: 4 } as const)[severity],
      );
}
export function formatPrepareRenameResult(
  result: PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null,
): string {
  if (result === null) return "Cannot rename at this position";
  if ("defaultBehavior" in result)
    return result.defaultBehavior
      ? "Rename supported (using default behavior)"
      : "Cannot rename at this position";
  const range = "range" in result ? result.range : result;
  return `Rename available at ${range.start.line + 1}:${range.start.character}-${range.end.line + 1}:${range.end.character}${"placeholder" in result && result.placeholder ? ` (current: "${result.placeholder}")` : ""}`;
}
export function formatApplyResult(result: ApplyResult): string {
  return result.success
    ? [
        `Applied ${result.totalEdits} edit(s) to ${result.filesModified.length} file(s):`,
        ...result.filesModified.map((file) => `  - ${file}`),
      ].join("\n")
    : ["Failed to apply some changes:", ...result.errors.map((error) => `  Error: ${error}`)].join(
        "\n",
      );
}
