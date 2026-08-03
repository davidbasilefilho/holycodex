import { describe, expect, it } from "vitest";

import { parseLspCliArgs } from "../src/cli.js";

describe("LSP CLI parsing", () => {
  it("parses semantic navigation and structured output", () => {
    expect(
      parseLspCliArgs(["declaration", "--file=a.ts", "--line", "2", "--character=4", "--json"]),
    ).toEqual({
      command: "goto_declaration",
      args: { filePath: "a.ts", line: 2, character: 4 },
      json: true,
    });
  });

  it("parses workspace symbols", () => {
    expect(
      parseLspCliArgs(["workspace-symbols", "--file", "a.ts", "--query", "Thing", "--limit", "20"]),
    ).toMatchObject({
      command: "symbols",
      args: { scope: "workspace", query: "Thing", limit: 20 },
    });
  });

  it.each([
    ["status", "--file=x"],
    ["rename", "--file=x", "--line=1", "--character=0"],
    ["diagnostics", "x"],
    ["unknown"],
  ])("rejects invalid syntax %#", (...args) => {
    expect(() => parseLspCliArgs(args)).toThrow();
  });
});
