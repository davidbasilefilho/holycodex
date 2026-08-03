import { describe, expect, it } from "vitest";

import { parseLauncherArgs } from "./cli";

describe("Git Bash launcher parsing", () => {
  it("accepts separated and equals values", () => {
    expect(
      parseLauncherArgs(["--cwd=C:/repo", "--command", "git status", "--timeout=5000"]),
    ).toEqual({ cwd: "C:/repo", command: "git status", timeoutMs: 5000 });
  });

  it.each([["--wat"], ["--command", "x", "--command=y"], ["position"], ["--cwd=x"]])(
    "rejects invalid arguments %#",
    (...args) => {
      expect(() => parseLauncherArgs(args)).toThrow();
    },
  );
});
