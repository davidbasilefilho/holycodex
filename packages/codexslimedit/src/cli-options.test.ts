import { describe, expect, it } from "vitest";

import { getCliAction } from "./cli-options.js";

const versionFlagCases: ReadonlyArray<readonly [readonly string[]]> = [[["--version"]], [["-v"]]];

const helpFlagCases: ReadonlyArray<readonly [readonly string[]]> = [[["--help"]], [["-h"]]];

describe("CodexSlimEdit CLI options", () => {
  it.each(versionFlagCases)("recognizes the version flag %o", (args) => {
    expect(getCliAction(args)).toBe("version");
  });

  it.each(helpFlagCases)("recognizes the help flag %o", (args) => {
    expect(getCliAction(args)).toBe("help");
  });

  it("prefers version when version and help flags are both present", () => {
    expect(getCliAction(["--help", "-v"])).toBe("version");
  });

  it("starts MCP for unrelated arguments", () => {
    expect(getCliAction(["serve", "--unknown"])).toBe("start");
  });
});
