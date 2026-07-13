import { describe, expect, test } from "vitest";

import { coerceToolArguments, executeLspTool, LSP_MCP_TOOLS } from "./tools.js";

const expectedToolSurface = [
  {
    name: "status",
    title: "LSP Status",
    description: "Use to inspect configured and active LSP servers without starting one.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "diagnostics",
    title: "LSP Diagnostics",
    description:
      "Use after code edits or during diagnosis to get errors, warnings, and hints for a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "File or directory path to check." },
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
    description: "Use to find the exact definition of a symbol before changing or explaining it.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "1-based line number." },
        character: { type: "number", description: "0-based column." },
      },
      required: ["filePath", "line", "character"],
    },
  },
  {
    name: "find_references",
    title: "LSP Find References",
    description:
      "Use to find every workspace reference before refactoring, renaming, or assessing impact.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "1-based line number." },
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
    description: "Use to outline one file or locate named symbols across the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "File path used as LSP context." },
        scope: {
          type: "string",
          enum: ["document", "workspace"],
          description: "Use document for file outline or workspace for project-wide search.",
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
    description: "Use before rename to verify the symbol and position support a semantic rename.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Source file path." },
        line: { type: "number", description: "1-based line number." },
        character: { type: "number", description: "0-based column." },
      },
      required: ["filePath", "line", "character"],
    },
  },
  {
    name: "rename",
    title: "LSP Rename",
    description: "Use for a semantic workspace-wide symbol rename after prepare_rename succeeds.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Source file path." },
        line: { type: "number", description: "1-based line number." },
        character: { type: "number", description: "0-based column." },
        newName: { type: "string", description: "New symbol name." },
      },
      required: ["filePath", "line", "character", "newName"],
    },
  },
  {
    name: "install_decision",
    title: "LSP Install Decision",
    description:
      "Use after a missing-server prompt to record explicit install permission or a decline; decline when permission was not explicit.",
    inputSchema: {
      type: "object",
      properties: {
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
