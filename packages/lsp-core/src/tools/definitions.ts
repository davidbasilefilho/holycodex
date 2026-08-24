// SPDX-License-Identifier: Apache-2.0

import { executeLspDiagnostics } from "./diagnostics.ts";
import { executeLspInstallDecision } from "./install-decision.ts";
import {
  executeLspFindReferences,
  executeLspGotoDeclaration,
  executeLspGotoDefinition,
} from "./navigation.ts";
import { executeLspPrepareRename, executeLspRename } from "./rename.ts";
import { executeLspStatus } from "./status.ts";
import { executeLspSymbols } from "./symbols.ts";
import type { JsonSchema, LspCommand } from "./types.ts";

const positionProperties: Readonly<Record<string, JsonSchema>> = {
  line: { type: "number", description: "1-based line." },
  character: { type: "number", description: "0-based column." },
};
const positionRequired = ["filePath", "line", "character"];
const objectSchema = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema => ({ type: "object", properties, ...(required.length === 0 ? {} : { required }) });

/** The stable public HolyCodex LSP command surface. */
export const LSP_COMMANDS: readonly LspCommand[] = Object.freeze([
  {
    name: "status",
    aliases: ["lsp_status"],
    title: "LSP Status",
    description: "List LSP servers without starting them.",
    inputSchema: objectSchema({}),
    execute: executeLspStatus,
  },
  {
    name: "diagnostics",
    aliases: ["lsp_diagnostics"],
    title: "LSP Diagnostics",
    description: "Get file or directory diagnostics.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string" },
        severity: { type: "string", enum: ["error", "warning", "information", "hint", "all"] },
      },
      ["filePath"],
    ),
    execute: executeLspDiagnostics,
  },
  {
    name: "goto_definition",
    aliases: ["lsp_goto_definition"],
    title: "LSP Goto Definition",
    description: "Find a symbol definition.",
    inputSchema: objectSchema(
      { filePath: { type: "string" }, ...positionProperties },
      positionRequired,
    ),
    execute: executeLspGotoDefinition,
  },
  {
    name: "goto_declaration",
    title: "LSP Goto Declaration",
    description: "Find a symbol declaration.",
    inputSchema: objectSchema(
      { filePath: { type: "string" }, ...positionProperties },
      positionRequired,
    ),
    execute: executeLspGotoDeclaration,
  },
  {
    name: "find_references",
    aliases: ["lsp_find_references"],
    title: "LSP Find References",
    description: "Find workspace symbol references.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string" },
        ...positionProperties,
        includeDeclaration: { type: "boolean" },
      },
      positionRequired,
    ),
    execute: executeLspFindReferences,
  },
  {
    name: "symbols",
    aliases: ["lsp_symbols"],
    title: "LSP Symbols",
    description: "Outline a file or search workspace symbols.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string" },
        scope: { type: "string", enum: ["document", "workspace"] },
        query: { type: "string" },
        limit: { type: "number" },
      },
      ["filePath", "scope"],
    ),
    execute: executeLspSymbols,
  },
  {
    name: "prepare_rename",
    aliases: ["lsp_prepare_rename"],
    title: "LSP Prepare Rename",
    description: "Check semantic-rename support.",
    inputSchema: objectSchema(
      { filePath: { type: "string" }, ...positionProperties },
      positionRequired,
    ),
    execute: executeLspPrepareRename,
  },
  {
    name: "rename",
    aliases: ["lsp_rename"],
    title: "LSP Rename",
    description: "Rename a workspace symbol after preparation.",
    inputSchema: objectSchema(
      { filePath: { type: "string" }, ...positionProperties, newName: { type: "string" } },
      [...positionRequired, "newName"],
    ),
    execute: executeLspRename,
  },
  {
    name: "install_decision",
    aliases: ["lsp_install_decision"],
    title: "LSP Install Decision",
    description: "Record an explicit LSP install decision.",
    inputSchema: objectSchema(
      {
        server_id: { type: "string" },
        decision: { type: "string", enum: ["declined", "allowed"] },
      },
      ["server_id", "decision"],
    ),
    execute: executeLspInstallDecision,
  },
]);
