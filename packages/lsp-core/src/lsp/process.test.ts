// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createSpawnCommand } from "./process.ts";

describe("portable LSP process preparation", () => {
  it("launches Windows command shims through the injected Git Bash path", () => {
    expect(
      createSpawnCommand(
        ["C:\\tools\\server.cmd", "--stdio"],
        "win32",
        { PATH: "" },
        { found: true, path: "C:\\Program Files\\Git\\bin\\bash.exe" },
      ),
    ).toEqual({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["-lc", 'exec "$@"', "holycodex-lsp", "C:\\tools\\server.cmd", "--stdio"],
      shell: false,
    });
  });

  it("fails closed when a Windows shim has no Git Bash", () => {
    expect(() =>
      createSpawnCommand(["C:\\tools\\server.cmd"], "win32", { PATH: "" }, { found: false }),
    ).toThrow("Git Bash is required");
  });
});
