import { describe, expect, it } from "vitest";

import { parseCliArguments } from "../packages/cli/src/arguments";

describe("command-specific CLI parsing", () => {
  it("accepts separated and equals install values", () => {
    expect(
      parseCliArguments(["install", "--plan=plus-high", "--max-subagents", "3", "--json"]),
    ).toMatchObject({ command: "install", plan: "plus-high", maxSubagents: 3, json: true });
  });

  it.each(["0", "1", "2", "3"])("accepts max-subagents=%s", (value) => {
    expect(parseCliArguments(["install", `--max-subagents=${value}`]).maxSubagents).toBe(
      Number(value),
    );
  });

  it("accepts verbose only for install while preserving top-level -v", () => {
    expect(parseCliArguments(["install", "-v"])).toMatchObject({ verbose: true });
    expect(parseCliArguments(["install", "--verbose"])).toMatchObject({ verbose: true });
    expect(parseCliArguments(["-v"])).toMatchObject({ action: "version", verbose: false });
    expect(() => parseCliArguments(["doctor", "-v"])).toThrow("not valid for doctor");
    expect(() => parseCliArguments(["install", "-v", "--verbose"])).toThrow("Repeated");
  });

  it.each(["-1", "4", "1.5", "x"])("rejects max-subagents=%s", (value) => {
    expect(() => parseCliArguments(["install", `--max-subagents=${value}`])).toThrow(
      "Expected an integer from 0 through 3",
    );
  });

  it("rejects unknown, repeated, conflicting, irrelevant, and positional arguments", () => {
    expect(() => parseCliArguments(["install", "--wat"])).toThrow("not valid for install");
    expect(() => parseCliArguments(["install", "--plan=plus", "--plan", "go"])).toThrow("Repeated");
    expect(() => parseCliArguments(["install", "--fast", "--fast-all"])).toThrow(
      "Conflicting Fast",
    );
    expect(() => parseCliArguments(["doctor", "--plan=plus"])).toThrow("not valid for doctor");
    expect(() => parseCliArguments(["cleanup", "extra"])).toThrow("Unexpected positional");
  });

  it("does not parse install-only flags for doctor or cleanup", () => {
    for (const command of ["doctor", "cleanup"] as const)
      for (const option of ["--plan=go", "--max-subagents=1", "--fast", "--codex-autonomous"])
        expect(() => parseCliArguments([command, option])).toThrow(`not valid for ${command}`);
  });
});
