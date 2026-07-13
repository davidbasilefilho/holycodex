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
    description: "Use to inspect configured and active LSP servers without starting one.",
    inputSchema: objectSchema({}),
    execute: executeLspStatus,
  },
  {
    name: "diagnostics",
    aliases: ["lsp_diagnostics"],
    title: "LSP Diagnostics",
    description:
      "Use after code edits or during diagnosis to get errors, warnings, and hints for a file or directory.",
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
    description: "Use to find the exact definition of a symbol before changing or explaining it.",
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
    description:
      "Use to find every workspace reference before refactoring, renaming, or assessing impact.",
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
    description: "Use to outline one file or locate named symbols across the workspace.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "File path used as LSP context." },
        scope: {
          type: "string",
          enum: ["document", "workspace"],
          description: "Use document for file outline or workspace for project-wide search.",
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
    description: "Use before rename to verify the symbol and position support a semantic rename.",
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
    description: "Use for a semantic workspace-wide symbol rename after prepare_rename succeeds.",
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
    description:
      "Use after a missing-server prompt to record explicit install permission or a decline; decline when permission was not explicit.",
    inputSchema: objectSchema(
      {
        server_id: {
          type: "string",
          description: "The LSP server id from the not-installed message (e.g. 'rust').",
        },
        decision: {
          type: "string",
          enum: ["declined", "allowed"],
          description: "'declined' silences future prompts; 'allowed' pre-authorizes installation.",
        },
      },
      ["server_id", "decision"],
    ),
    execute: executeLspInstallDecision,
  },
];
