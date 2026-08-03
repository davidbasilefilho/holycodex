import { executeLspDiagnostics } from "./diagnostics.js";
import { executeLspInstallDecision } from "./install-decision.js";
import {
  executeLspFindReferences,
  executeLspGotoDeclaration,
  executeLspGotoDefinition,
} from "./navigation.js";
import { executeLspPrepareRename, executeLspRename } from "./rename.js";
import { objectSchema } from "./schema.js";
import { executeLspStatus } from "./status.js";
import { executeLspSymbols } from "./symbols.js";
import type { JsonSchema, LspCommand } from "./types.js";

const POSITION_PROPERTIES = {
  line: { type: "number", description: "1-based line." },
  character: { type: "number", description: "0-based column." },
} satisfies Record<string, JsonSchema>;
const POSITION_REQUIRED = ["filePath", "line", "character"];

export const LSP_COMMANDS: LspCommand[] = [
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
        filePath: { type: "string", description: "File or directory." },
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
    description: "Find a symbol definition.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "Source file." },
        ...POSITION_PROPERTIES,
      },
      POSITION_REQUIRED,
    ),
    execute: executeLspGotoDefinition,
  },
  {
    name: "goto_declaration",
    title: "LSP Goto Declaration",
    description: "Find a symbol declaration.",
    inputSchema: objectSchema(
      { filePath: { type: "string" }, ...POSITION_PROPERTIES },
      POSITION_REQUIRED,
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
        filePath: { type: "string", description: "Source file." },
        ...POSITION_PROPERTIES,
        includeDeclaration: {
          type: "boolean",
          description: "Include the declaration. Defaults to true.",
        },
      },
      POSITION_REQUIRED,
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
        filePath: { type: "string", description: "LSP context file." },
        scope: {
          type: "string",
          enum: ["document", "workspace"],
          description: "document: outline; workspace: project search.",
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
    description: "Check semantic-rename support.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "Source file." },
        ...POSITION_PROPERTIES,
      },
      POSITION_REQUIRED,
    ),
    execute: executeLspPrepareRename,
  },
  {
    name: "rename",
    aliases: ["lsp_rename"],
    title: "LSP Rename",
    description: "Rename workspace symbol after prepare_rename succeeds.",
    inputSchema: objectSchema(
      {
        filePath: { type: "string", description: "Source file." },
        ...POSITION_PROPERTIES,
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
    description: "Record LSP install permission or decline.",
    inputSchema: objectSchema(
      {
        server_id: {
          type: "string",
          description: "Server id from not-installed message, e.g. rust.",
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
