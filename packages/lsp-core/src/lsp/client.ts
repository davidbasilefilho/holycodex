import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { contextCwd } from "../request-context.js";
import { LspClientConnection } from "./connection.js";
import { effectiveExtension } from "./effective-extension.js";
import { getLanguageId } from "./language-mappings.js";
import {
  DefinitionResultSchema,
  DiagnosticReportSchema,
  DocumentSymbolsResultSchema,
  PrepareRenameResultSchema,
  ReferencesResultSchema,
  WorkspaceEditSchema,
  WorkspaceSymbolsResultSchema,
} from "./protocol-schemas.js";
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
} from "./types.js";

const POST_OPEN_DELAY_MS = 1000;
const POST_DIAGNOSTICS_WAIT_MS = 500;
const NumericErrorCodeSchema = z.looseObject({ code: z.number() });

export class LspClient extends LspClientConnection {
  private readonly openedFiles = new Set<string>();
  private readonly documentVersions = new Map<string, number>();
  private readonly lastSyncedText = new Map<string, string>();
  private readonly diagnosticPullErrors: Error[] = [];

  /** Returns diagnostic pull failures collected during fallback. */
  getDiagnosticPullErrors(): readonly Error[] {
    return this.diagnosticPullErrors;
  }

  /** Opens or synchronizes a source file with the language server. */
  async openFile(filePath: string): Promise<void> {
    const absPath = resolve(contextCwd(), filePath);
    const uri = pathToFileURL(absPath).href;
    const text = readFileSync(absPath, "utf-8");

    if (!this.openedFiles.has(absPath)) {
      const ext = effectiveExtension(absPath);
      const languageId = getLanguageId(ext);
      const version = 1;

      await this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version,
          text,
        },
      });

      this.openedFiles.add(absPath);
      this.documentVersions.set(uri, version);
      this.lastSyncedText.set(uri, text);
      await new Promise((r) => setTimeout(r, POST_OPEN_DELAY_MS));
      return;
    }

    const prevText = this.lastSyncedText.get(uri);
    if (prevText === text) {
      return;
    }

    const nextVersion = (this.documentVersions.get(uri) ?? 1) + 1;
    this.documentVersions.set(uri, nextVersion);
    this.lastSyncedText.set(uri, text);

    await this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });

    await this.sendNotification("textDocument/didSave", {
      textDocument: { uri },
      text,
    });
  }

  /** Requests and validates definition locations. */
  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Location | LocationLink | Array<Location | LocationLink> | null> {
    const textDocument = await this.openTextDocument(filePath);
    return this.sendRequest("textDocument/definition", DefinitionResultSchema, {
      textDocument,
      position: { line: line - 1, character },
    });
  }

  /** Requests and validates reference locations. */
  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<Location[]> {
    const textDocument = await this.openTextDocument(filePath);
    return this.sendRequest("textDocument/references", ReferencesResultSchema, {
      textDocument,
      position: { line: line - 1, character },
      context: { includeDeclaration },
    });
  }

  /** Requests and validates document symbols. */
  async documentSymbols(filePath: string): Promise<Array<DocumentSymbol | SymbolInfo>> {
    const textDocument = await this.openTextDocument(filePath);
    return this.sendRequest("textDocument/documentSymbol", DocumentSymbolsResultSchema, {
      textDocument,
    });
  }

  /** Requests and validates workspace symbols. */
  async workspaceSymbols(query: string): Promise<SymbolInfo[]> {
    return this.sendRequest("workspace/symbol", WorkspaceSymbolsResultSchema, { query });
  }

  private isUnsupportedDiagnosticPullError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = NumericErrorCodeSchema.safeParse(error).data?.code;
    if (code === -32601) return true;
    return /unsupported|not supported|method not found|unknown request/i.test(error.message);
  }

  /** Requests diagnostics and falls back to pushed diagnostics. */
  async diagnostics(filePath: string): Promise<{ items: Diagnostic[] }> {
    const { uri } = await this.openTextDocument(filePath);
    await new Promise((r) => setTimeout(r, POST_DIAGNOSTICS_WAIT_MS));

    try {
      const result = await this.sendRequest("textDocument/diagnostic", DiagnosticReportSchema, {
        textDocument: { uri },
      });
      if (result.items) {
        return { items: result.items };
      }
    } catch (error) {
      if (!this.isUnsupportedDiagnosticPullError(error)) {
        this.diagnosticPullErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return { items: this.getStoredDiagnostics(uri) };
  }

  /** Requests and validates rename preparation data. */
  async prepareRename(
    filePath: string,
    line: number,
    character: number,
  ): Promise<PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null> {
    const textDocument = await this.openTextDocument(filePath);
    return this.sendRequest("textDocument/prepareRename", PrepareRenameResultSchema, {
      textDocument,
      position: { line: line - 1, character },
    });
  }

  /** Requests and validates a workspace rename edit. */
  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const textDocument = await this.openTextDocument(filePath);
    return this.sendRequest("textDocument/rename", WorkspaceEditSchema.nullable(), {
      textDocument,
      position: { line: line - 1, character },
      newName,
    });
  }

  private async openTextDocument(filePath: string): Promise<{ readonly uri: string }> {
    const absPath = resolve(contextCwd(), filePath);
    await this.openFile(absPath);
    return { uri: pathToFileURL(absPath).href };
  }
}
