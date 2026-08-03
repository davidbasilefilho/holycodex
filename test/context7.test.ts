import { describe, expect, it } from "vitest";

import { context7Command } from "../packages/cli/src/context7";

describe("Context7 direct runner", () => {
  it.each([
    [["nubx"], "nubx", ["-y", "ctx7@latest"]],
    [["nub"], "nub", ["dlx", "ctx7@latest"]],
    [["bunx"], "bunx", ["ctx7@latest"]],
    [["bun"], "bun", ["x", "ctx7@latest"]],
    [["pnpmx"], "pnpmx", ["ctx7@latest"]],
    [["pnpm"], "pnpm", ["dlx", "ctx7@latest"]],
    [["npm"], "npx", ["--yes", "ctx7@latest"]],
    [["yarn"], "yarn", ["dlx", "ctx7@latest"]],
  ] as const)("constructs %s runner", (available, command, prefix) => {
    const result = context7Command(
      ["docs", "/a/b", "query"],
      (name) => available.includes(name as never),
      {},
    );
    expect(result).toMatchObject({
      command,
      args: [...prefix, "docs", "/a/b", "query"],
      env: { CI: "1" },
    });
  });

  it("uses the declared precedence and returns undefined without a runner", () => {
    expect(context7Command([], (name) => name === "npm" || name === "bun")).toMatchObject({
      command: "bun",
    });
    expect(context7Command([], () => false)).toBeUndefined();
  });
});
