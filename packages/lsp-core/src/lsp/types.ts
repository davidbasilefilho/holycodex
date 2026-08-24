// SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "./schema.ts";

export interface LspServerConfig {
  readonly id: string;
  readonly command: readonly string[];
  readonly extensions: readonly string[];
  readonly disabled?: boolean | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly initialization?: JsonObject | undefined;
}

export interface ResolvedServer {
  readonly id: string;
  readonly command: readonly string[];
  readonly extensions: readonly string[];
  readonly priority: number;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly initialization?: JsonObject | undefined;
}

export interface ServerLookupInfo {
  readonly id: string;
  readonly command: readonly string[];
  readonly extensions: readonly string[];
}

export type ServerLookupResult =
  | { readonly status: "found"; readonly server: ResolvedServer }
  | {
      readonly status: "not_configured";
      readonly extension: string;
      readonly availableServers: readonly string[];
    }
  | {
      readonly status: "not_installed";
      readonly server: ServerLookupInfo;
      readonly installHint: string;
    };

export interface Position {
  readonly line: number;
  readonly character: number;
}
export interface Range {
  readonly start: Position;
  readonly end: Position;
}
export interface Location {
  readonly uri: string;
  readonly range: Range;
}
export interface LocationLink {
  readonly targetUri: string;
  readonly targetRange: Range;
  readonly targetSelectionRange: Range;
  readonly originSelectionRange?: Range | undefined;
}
export interface SymbolInfo {
  readonly name: string;
  readonly kind: number;
  readonly location: Location;
  readonly containerName?: string | undefined;
}
export interface DocumentSymbol {
  readonly name: string;
  readonly kind: number;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children?: readonly DocumentSymbol[] | undefined;
}
export interface Diagnostic {
  readonly range: Range;
  readonly severity?: number | undefined;
  readonly code?: string | number | undefined;
  readonly source?: string | undefined;
  readonly message: string;
}
export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}
export interface VersionedTextDocumentIdentifier {
  readonly uri: string;
  readonly version: number | null;
}
export interface TextDocumentEdit {
  readonly textDocument: VersionedTextDocumentIdentifier;
  readonly edits: readonly TextEdit[];
}
export interface CreateFile {
  readonly kind: "create";
  readonly uri: string;
  readonly options?:
    | { readonly overwrite?: boolean | undefined; readonly ignoreIfExists?: boolean | undefined }
    | undefined;
}
export interface RenameFile {
  readonly kind: "rename";
  readonly oldUri: string;
  readonly newUri: string;
  readonly options?:
    | { readonly overwrite?: boolean | undefined; readonly ignoreIfExists?: boolean | undefined }
    | undefined;
}
export interface DeleteFile {
  readonly kind: "delete";
  readonly uri: string;
  readonly options?:
    | { readonly recursive?: boolean | undefined; readonly ignoreIfNotExists?: boolean | undefined }
    | undefined;
}
export interface WorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly TextEdit[]>> | undefined;
  readonly documentChanges?:
    | readonly (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[]
    | undefined;
}
export interface PrepareRenameResult {
  readonly range: Range;
  readonly placeholder?: string | undefined;
}
export interface PrepareRenameDefaultBehavior {
  readonly defaultBehavior: boolean;
}
export type SeverityFilter = "error" | "warning" | "information" | "hint" | "all";
