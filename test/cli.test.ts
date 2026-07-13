import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("CLI", () => {
  it("prints version under Node", async () => {
    const result = await run(process.execPath, ["src/cli.ts", "--version"]);
    expect(result.stdout).toBe("0.4.1\n");
  });
});
