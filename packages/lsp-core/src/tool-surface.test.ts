import { describe, expect, test } from "vitest";

import { coerceToolArguments, executeLspTool, LSP_MCP_TOOLS } from "./tools.js";

const expectedToolSurface = [
  {
    name: "status",
    title: "LSP Status",
    description: "List LSP servers without starting them.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "diagnostics",
    title: "LSP Diagnostics",
    description: "Get file or directory diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "File or directory." },
        severity: {
          type: "string",
          enum: ["error", "warning", "information", "hint", "all"],
          description: "Severity filter. Defaults to all.",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "goto_definition",
    title: "LSP Goto Definition",
    description: "Find a symbol definition.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Source file." },
        line: { type: "number", description: "1-based line." },
        character: { type: "number", description: "0-based column." },
      },
      required: ["filePath", "line", "character"],
    },
  },
  {
    name: "find_references",
    title: "LSP Find References",
    description: "Find workspace symbol references.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Source file." },
        line: { type: "number", description: "1-based line." },
        character: { type: "number", description: "0-based column." },
        includeDeclaration: {
          type: "boolean",
          description: "Include the declaration. Defaults to true.",
        },
      },
      required: ["filePath", "line", "character"],
    },
  },
  {
    name: "symbols",
    title: "LSP Symbols",
    description: "Outline a file or search workspace symbols.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "LSP context file." },
        scope: {
          type: "string",
          enum: ["document", "workspace"],
          description: "document: outline; workspace: project search.",
        },
        query: { type: "string", description: "Workspace symbol query." },
        limit: { type: "number", description: "Maximum number of symbols to return." },
      },
      required: ["filePath", "scope"],
    },
  },
  {
    name: "prepare_rename",
    title: "LSP Prepare Rename",
    description: "Check semantic-rename support.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Source file." },
        line: { type: "number", description: "1-based line." },
        character: { type: "number", description: "0-based column." },
      },
      required: ["filePath", "line", "character"],
    },
  },
  {
    name: "rename",
    title: "LSP Rename",
    description: "Rename workspace symbol after prepare_rename succeeds.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Source file." },
        line: { type: "number", description: "1-based line." },
        character: { type: "number", description: "0-based column." },
        newName: { type: "string", description: "New symbol name." },
      },
      required: ["filePath", "line", "character", "newName"],
    },
  },
  {
    name: "install_decision",
    title: "LSP Install Decision",
    description: "Record LSP install permission or decline.",
    inputSchema: {
      type: "object",
      properties: {
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
      required: ["server_id", "decision"],
    },
  },
];

describe("LSP core tool surface", () => {
  test("#given tool descriptors #when listed #then the public eight-tool schemas are pinned", () => {
    // given / when
    const surface = LSP_MCP_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    // then
    expect(surface).toEqual(expectedToolSurface);
  });

  test("#given legacy tool aliases #when executed #then aliases are callable but not listed", async () => {
    // given / when
    const result = await executeLspTool("lsp_diagnostics", { filePath: "module.wat" });

    // then
    expect(result.content[0]?.text).toContain("No LSP server configured for extension: .wat");
    expect(LSP_MCP_TOOLS.map((tool) => tool.name)).not.toContain("lsp_diagnostics");
  });

  test("#given non-object tool arguments #when coerced #then they produce an empty argument record", () => {
    // given / when / then
    expect(coerceToolArguments(null)).toEqual({});
    expect(coerceToolArguments(["filePath"])).toEqual({});
  });
});
