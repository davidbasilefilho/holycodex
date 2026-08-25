// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { join } from "node:path";
import {
  resolveWindowsBuildEnvironment,
  summarizeCompilerVersion,
} from "./build-safe-filesystem.ts";

describe("Windows safe filesystem build environment", () => {
  test("activates the discovered Visual Studio x64 toolchain", async () => {
    const commands: string[][] = [];
    const environment = await resolveWindowsBuildEnvironment({
      env: { "ProgramFiles(x86)": "C:\\Program Files (x86)", SystemRoot: "C:\\Windows" },
      isRegularFile: async (path) => path.endsWith("vswhere.exe") || path.endsWith("vcvars64.bat"),
      run: async (command) => {
        commands.push([...command]);
        return {
          command: [...command],
          exitCode: 0,
          stdout: command[0]?.endsWith("vswhere.exe")
            ? "C:\\Visual Studio\\BuildTools\r\n"
            : "Path=C:\\Visual Studio\\BuildTools\\VC\\bin\r\nINCLUDE=C:\\SDK\\include\r\n",
          stderr: "",
        };
      },
    });

    expect(environment["Path"]).toContain("BuildTools");
    expect(environment["INCLUDE"]).toBe("C:\\SDK\\include");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual([
      join("C:\\Windows", "System32", "cmd.exe"),
      "/d",
      "/s",
      "/c",
      "call",
      join("C:\\Visual Studio\\BuildTools", "VC", "Auxiliary", "Build", "vcvars64.bat"),
      "amd64",
      ">nul",
      "&&",
      "set",
    ]);
  });

  test("fails with an actionable message when the C++ toolchain is absent", async () => {
    await expect(
      resolveWindowsBuildEnvironment({
        env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        isRegularFile: async () => false,
      }),
    ).rejects.toThrow("Desktop development with C++");
  });
});

describe("safe filesystem compiler identity", () => {
  test("keeps the concise MSVC banner instead of the full help output", () => {
    const summary = summarizeCompilerVersion("win32", {
      command: ["cl.exe", "/?"],
      exitCode: 0,
      stdout: `C/C++ COMPILER OPTIONS\n${"option ".repeat(1000)}`,
      stderr: "Microsoft (R) C/C++ Optimizing Compiler Version 19.50 for x64\r\n",
    });

    expect(summary).toBe("Microsoft (R) C/C++ Optimizing Compiler Version 19.50 for x64");
  });

  test("retains the Linux compiler banner within the manifest limit", () => {
    const summary = summarizeCompilerVersion("linux", {
      command: ["cc", "--version"],
      exitCode: 0,
      stdout: `cc (Ubuntu 14.2.0) 14.2.0\n${"option ".repeat(1000)}`,
      stderr: "",
    });

    expect(summary.startsWith("cc (Ubuntu 14.2.0) 14.2.0")).toBe(true);
    expect(summary).toHaveLength(4096);
  });
});
