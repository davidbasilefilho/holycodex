// SPDX-License-Identifier: Apache-2.0

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
  WorkspaceEdit,
} from "../lsp/types.ts";
import type { ApplyResult } from "../lsp/workspace-edit.ts";

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}
export interface ToolExecutionResult {
  readonly content: readonly TextContent[];
  readonly isError?: boolean | undefined;
  readonly details?: unknown;
}
export interface JsonSchema {
  readonly type: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
}
export interface LspCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly execute: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolExecutionResult>;
}
export interface LspDiagnosticsDetails {
  readonly filePath: string;
  readonly severity: SeverityFilter;
  readonly mode: "file" | "directory";
  readonly diagnostics: readonly { readonly file: string; readonly diagnostic: Diagnostic }[];
  readonly totalDiagnostics: number;
  readonly truncated: boolean;
  readonly error?: string;
  readonly errorKind?: "missing_dependency" | "no_files" | "invalid_path";
}
export interface LspGotoDefinitionDetails {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
  readonly locations: readonly (Location | LocationLink)[];
  readonly error?: string;
  readonly errorKind?: "missing_dependency";
}
export interface LspFindReferencesDetails {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
  readonly references: readonly Location[];
  readonly totalReferences: number;
  readonly truncated: boolean;
  readonly error?: string;
  readonly errorKind?: "missing_dependency";
}
export interface LspSymbolsDetails {
  readonly filePath: string;
  readonly scope: "document" | "workspace";
  readonly query?: string;
  readonly symbols: readonly (DocumentSymbol | SymbolInfo)[];
  readonly totalSymbols: number;
  readonly truncated: boolean;
  readonly error?: string;
  readonly errorKind?: "missing_dependency" | "missing_query";
}
export interface LspPrepareRenameDetails {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
  readonly result: PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null;
  readonly error?: string;
  readonly errorKind?: "missing_dependency";
}
export interface LspRenameDetails {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
  readonly newName: string;
  readonly apply: ApplyResult | null;
  readonly edit: WorkspaceEdit | null;
  readonly error?: string;
  readonly errorKind?: "missing_dependency";
}
