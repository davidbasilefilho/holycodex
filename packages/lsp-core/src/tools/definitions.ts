import { executeLspDiagnostics } from "./diagnostics.js";
import { executeLspInstallDecision } from "./install-decision.js";
import { executeLspFindReferences, executeLspGotoDefinition } from "./navigation.js";
import { executeLspPrepareRename, executeLspRename } from "./rename.js";
import { objectSchema } from "./schema.js";
import { executeLspStatus } from "./status.js";
import { executeLspSymbols } from "./symbols.js";
import type { LspMcpTool } from "./types.js";

export const LSP_MCP_TOOLS: LspMcpTool[] = [
  {
    name: "status",
    aliases: ["lsp_status"],
    title: "LSP Status",
    description: "Use to list LSP servers without starting them.",
    inputSchema: objectSchema({}),
    execute: executeLspStatus,
  },
  {
    name: "diagnostics",
    aliases: ["lsp_diagnostics"],
    title: "LSP Diagnostics",
    description: "Use to get file or directory diagnostics.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "File or directory path to check." },
        severity: {
          type: "string",
          enum: ["error", "warning", "information", "hint", "all"],
          description: "Severity filter. Defaults to all.",
        },
      },
      ["filePath"],
    ),
    execute: executeLspDiagnostics,
  },
  {
    name: "goto_definition",
    aliases: ["lsp_goto_definition"],
    title: "LSP Goto Definition",
    description: "Use to find a symbol's definition.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "1-based line number." },
        character: { type: "number", description: "0-based column." },
      },
      ["filePath", "line", "character"],
    ),
    execute: executeLspGotoDefinition,
  },
  {
    name: "find_references",
    aliases: ["lsp_find_references"],
    title: "LSP Find References",
    description: "Use to find all workspace references to a symbol.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "1-based line number." },
        character: { type: "number", description: "0-based column." },
        includeDeclaration: {
          type: "boolean",
          description: "Include the declaration. Defaults to true.",
        },
      },
      ["filePath", "line", "character"],
    ),
    execute: executeLspFindReferences,
  },
  {
    name: "symbols",
    aliases: ["lsp_symbols"],
    title: "LSP Symbols",
    description: "Use to outline a file or search workspace symbols.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "File path used as LSP context." },
        scope: {
          type: "string",
          enum: ["document", "workspace"],
          description: "document outlines a file; workspace searches the project.",
        },
        query: { type: "string", description: "Workspace symbol query." },
        limit: { type: "number", description: "Maximum number of symbols to return." },
      },
      ["filePath", "scope"],
    ),
    execute: executeLspSymbols,
  },
  {
    name: "prepare_rename",
    aliases: ["lsp_prepare_rename"],
    title: "LSP Prepare Rename",
    description: "Use to check whether a symbol supports semantic rename.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "Source file path." },
        line: { type: "number", description: "1-based line number." },
        character: { type: "number", description: "0-based column." },
      },
      ["filePath", "line", "character"],
    ),
    execute: executeLspPrepareRename,
  },
  {
    name: "rename",
    aliases: ["lsp_rename"],
    title: "LSP Rename",
    description: "Use to rename a symbol workspace-wide after prepare_rename succeeds.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "Source file path." },
        line: { type: "number", description: "1-based line number." },
        character: { type: "number", description: "0-based column." },
        newName: { type: "string", description: "New symbol name." },
      },
      ["filePath", "line", "character", "newName"],
    ),
    execute: executeLspRename,
  },
  {
    name: "install_decision",
    aliases: ["lsp_install_decision"],
    title: "LSP Install Decision",
    description: "Use to record explicit LSP install permission or decline.",
    inputSchema: objectSchema(
      {
        server_id: {
          type: "string",
          description: "Server id from the not-installed message, e.g. rust.",
        },
        decision: {
          type: "string",
          enum: ["declined", "allowed"],
          description: "declined silences prompts; allowed authorizes installation.",
        },
      },
      ["server_id", "decision"],
    ),
    execute: executeLspInstallDecision,
  },
];
