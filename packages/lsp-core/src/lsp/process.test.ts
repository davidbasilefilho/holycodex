import { describe, expect, it } from "vitest";
import { createSpawnCommand } from "./process.js";

describe("Windows LSP process spawning", () => {
  it("launches command shims through Git Bash", () => {
    const shim = "C:\\tools\\server.cmd";
    const prepared = createSpawnCommand(
      [shim, "--stdio"],
      "win32",
      { PATH: "" },
      {
        found: true,
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        source: "env",
        checkedPaths: [],
      },
    );
    expect(prepared).toEqual({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["-lc", 'exec "$@"', "holycodex-lsp", shim, "--stdio"],
      shell: false,
    });
  });

  it("rejects command shims when Git Bash is unavailable", () => {
    expect(() =>
      createSpawnCommand(
        ["C:\\tools\\server.cmd"],
        "win32",
        { PATH: "" },
        { found: false, checkedPaths: [], installHint: "Install Git Bash." },
      ),
    ).toThrow("Git Bash is required");
  });
});
