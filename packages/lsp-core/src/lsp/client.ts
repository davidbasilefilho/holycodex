// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Schema from "effect/Schema";
import { contextCwd } from "../request-context.ts";
import { LspClientConnection } from "./connection.ts";
import type { LspClientTransportOptions } from "./transport.ts";
import { effectiveExtension } from "./effective-extension.ts";
import { getLanguageId } from "./language-mappings.ts";
import {
  DefinitionResultSchema,
  DiagnosticReportSchema,
  DocumentSymbolsResultSchema,
  PrepareRenameResultSchema,
  ReferencesResultSchema,
  WorkspaceEditSchema,
  WorkspaceSymbolsResultSchema,
} from "./protocol-schemas.ts";
import { resolveWorkspacePath } from "./workspace-security.ts";
import type {
  Diagnostic,
  DocumentSymbol,
  Location,
  LocationLink,
  PrepareRenameDefaultBehavior,
  PrepareRenameResult,
  Range,
  SymbolInfo,
  WorkspaceEdit,
} from "./types.ts";

export interface LspClientOptions {
  readonly postOpenDelayMs?: number;
  readonly postDiagnosticsWaitMs?: number;
}

/** Implements the public LSP document, navigation, diagnostics, symbol, and rename operations. */
export class LspClient extends LspClientConnection {
  private readonly openedFiles = new Set<string>();
  private readonly documentVersions = new Map<string, number>();
  private readonly lastSyncedText = new Map<string, string>();
  private readonly diagnosticPullErrors: Error[] = [];
  private readonly postOpenDelayMs: number;
  private readonly postDiagnosticsWaitMs: number;

  constructor(
    root: string,
    server: import("./types.ts").ResolvedServer,
    transportOptions: LspClientTransportOptions = {},
    options: LspClientOptions = {},
  ) {
    super(root, server, transportOptions);
    this.postOpenDelayMs = options.postOpenDelayMs ?? 1_000;
    this.postDiagnosticsWaitMs = options.postDiagnosticsWaitMs ?? 500;
  }

  /** Returns non-fatal diagnostic pull errors collected during push fallback. */
  getDiagnosticPullErrors(): readonly Error[] {
    return [...this.diagnosticPullErrors];
  }

  /** Opens or synchronizes a file after workspace confinement validation. */
  async openFile(filePath: string, signal?: AbortSignal): Promise<void> {
    const absolute = resolveWorkspacePath(this.root, resolve(contextCwd(), filePath));
    if (!existsSync(absolute) || !statSync(absolute).isFile())
      throw new Error(`LSP source file is unavailable: ${absolute}`);
    const uri = pathToFileURL(absolute).href;
    const text = readFileSync(absolute, "utf8");
    if (!this.openedFiles.has(absolute)) {
      await this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: getLanguageId(effectiveExtension(absolute)),
          version: 1,
          text,
        },
      });
      this.openedFiles.add(absolute);
      this.documentVersions.set(uri, 1);
      this.lastSyncedText.set(uri, text);
      if (this.postOpenDelayMs > 0) await delay(this.postOpenDelayMs);
      return;
    }
    if (this.lastSyncedText.get(uri) === text) return;
    const version = (this.documentVersions.get(uri) ?? 1) + 1;
    this.documentVersions.set(uri, version);
    this.lastSyncedText.set(uri, text);
    await this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    await this.sendNotification("textDocument/didSave", { textDocument: { uri }, text });
    signal?.throwIfAborted();
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
    signal?: AbortSignal,
  ): Promise<Location | LocationLink | readonly (Location | LocationLink)[] | null> {
    const textDocument = await this.openTextDocument(filePath, signal);
    return this.sendRequest<Location | LocationLink | readonly (Location | LocationLink)[] | null>(
      "textDocument/definition",
      DefinitionResultSchema,
      { textDocument, position: { line: line - 1, character } },
      { signal },
    );
  }

  async declaration(
    filePath: string,
    line: number,
    character: number,
    signal?: AbortSignal,
  ): Promise<Location | LocationLink | readonly (Location | LocationLink)[] | null> {
    const textDocument = await this.openTextDocument(filePath, signal);
    return this.sendRequest<Location | LocationLink | readonly (Location | LocationLink)[] | null>(
      "textDocument/declaration",
      DefinitionResultSchema,
      { textDocument, position: { line: line - 1, character } },
      { signal },
    );
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
    signal?: AbortSignal,
  ): Promise<readonly Location[]> {
    const textDocument = await this.openTextDocument(filePath, signal);
    const result = await this.sendRequest<readonly Location[]>(
      "textDocument/references",
      ReferencesResultSchema,
      { textDocument, position: { line: line - 1, character }, context: { includeDeclaration } },
      { signal },
    );
    return result ?? [];
  }

  async documentSymbols(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<readonly (DocumentSymbol | SymbolInfo)[]> {
    const textDocument = await this.openTextDocument(filePath, signal);
    const result = await this.sendRequest<readonly (DocumentSymbol | SymbolInfo)[]>(
      "textDocument/documentSymbol",
      DocumentSymbolsResultSchema,
      { textDocument },
      { signal },
    );
    return result ?? [];
  }

  async workspaceSymbols(query: string, signal?: AbortSignal): Promise<readonly SymbolInfo[]> {
    const result = await this.sendRequest<readonly SymbolInfo[]>(
      "workspace/symbol",
      WorkspaceSymbolsResultSchema,
      { query },
      { signal },
    );
    return result ?? [];
  }

  /** Requests pull diagnostics and falls back to bounded pushed diagnostics. */
  async diagnostics(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{ readonly items: readonly Diagnostic[] }> {
    const { uri } = await this.openTextDocument(filePath, signal);
    if (this.postDiagnosticsWaitMs > 0) await delay(this.postDiagnosticsWaitMs);
    try {
      const result = await this.sendRequest<{
        readonly items?: readonly Diagnostic[] | undefined;
      }>("textDocument/diagnostic", DiagnosticReportSchema, { textDocument: { uri } }, { signal });
      return { items: result.items ?? [] };
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !/unsupported|not supported|method not found|unknown request/i.test(error.message)
      )
        this.diagnosticPullErrors.push(error instanceof Error ? error : new Error(String(error)));
      return { items: this.getStoredDiagnostics(uri) };
    }
  }

  async prepareRename(
    filePath: string,
    line: number,
    character: number,
    signal?: AbortSignal,
  ): Promise<PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null> {
    const textDocument = await this.openTextDocument(filePath, signal);
    return this.sendRequest<PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null>(
      "textDocument/prepareRename",
      PrepareRenameResultSchema,
      { textDocument, position: { line: line - 1, character } },
      { signal },
    );
  }

  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceEdit | null> {
    const textDocument = await this.openTextDocument(filePath, signal);
    const result = await this.sendRequest<WorkspaceEdit | null>(
      "textDocument/rename",
      SchemaNullableWorkspaceEdit,
      { textDocument, position: { line: line - 1, character }, newName },
      { signal },
    );
    return result;
  }

  private async openTextDocument(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{ readonly uri: string }> {
    const absolute = resolveWorkspacePath(this.root, resolve(contextCwd(), filePath));
    await this.openFile(absolute, signal);
    return { uri: pathToFileURL(absolute).href };
  }
}

const SchemaNullableWorkspaceEdit: Schema.Schema<WorkspaceEdit | null> = Schema.Union(
  WorkspaceEditSchema,
  Schema.Null,
);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
