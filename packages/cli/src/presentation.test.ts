// SPDX-License-Identifier: Apache-2.0

import { CLI_SCHEMA_VERSION } from "@holycodex/core";
import { describe, expect, test } from "vite-plus/test";

import { renderHelp, renderHuman, runCli, runBinary, type CommandResult } from "./index.ts";

describe("human CLI presentation", () => {
  test("renders aligned success data without ANSI when output is not a TTY", async () => {
    const result = await runCli(["version"]);
    expect(renderHuman(result, { stdoutIsTTY: false, env: {} })).toMatch(/^holycodex \S+\n$/u);
  });

  test("prints the version shortcut as one concise line", async () => {
    let stdout = "";
    const exitCode = await runBinary(["--version"], {
      stdoutIsTTY: false,
      stderrIsTTY: false,
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^holycodex \S+\n$/u);
  });

  test("uses semantic ANSI only for interactive non-CI help", () => {
    const topLevel = renderHelp(undefined, { stdoutIsTTY: true, env: {} });
    const rendered = renderHelp("install", { stdoutIsTTY: true, env: {} });
    expect(topLevel).toContain("\u001b[1mHolyCodex\u001b[0m");
    expect(rendered).toContain("\u001b[1mUsage:\u001b[0m");
    expect(rendered).toContain("\u001b[36m--frontend\u001b[0m");
    expect(renderHelp("install", { stdoutIsTTY: true, env: { NO_COLOR: "1" } })).not.toContain(
      "\u001b[",
    );
    expect(renderHelp("install", { stdoutIsTTY: true, env: { CI: "true" } })).not.toContain(
      "\u001b[",
    );
    expect(renderHelp("install", { stdoutIsTTY: false, env: {} })).not.toContain("\u001b[");
  });

  test("summarizes installation state without exposing the internal record", () => {
    const result = {
      envelope: {
        schema_version: CLI_SCHEMA_VERSION,
        ok: true,
        command: "install",
        data: {
          record: {
            version: "1.2.3",
            plan: "go",
            tier: "standard",
            install_id: "private-id",
            digest: "private-digest",
            optional_selections: {
              frontend: true,
              security: true,
              work: false,
              computer_use: false,
            },
            capability_state: {
              frontend: { status: "healthy" },
              security: { status: "healthy" },
            },
          },
          preserved: [],
          warnings: ["review provider availability"],
        },
        warnings: [],
      },
      exitCode: 0,
    } as CommandResult;
    const rendered = renderHuman(result, { stdoutIsTTY: false, env: {} });
    expect(rendered).toContain("version: 1.2.3");
    expect(rendered).toContain("plan: go");
    expect(rendered).toContain("capabilities: frontend, security");
    expect(rendered).toContain("warning: review provider availability");
    expect(rendered).not.toContain("private-id");
    expect(rendered).not.toContain("private-digest");
  });

  test("renders actionable errors on stderr and keeps JSON as one envelope on stdout", async () => {
    let stdout = "";
    let stderr = "";
    const io = {
      stdoutIsTTY: false,
      stderrIsTTY: false,
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    };
    const humanExit = await runBinary(["doctor", "--unknown"], io);
    expect(humanExit).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatchInlineSnapshot(`
      "✖ doctor
        invalid_argument: Unknown option.
        option: --unknown
        hint: holycodex doctor --help
      "
    `);

    stdout = "";
    stderr = "";
    const jsonExit = await runBinary(["doctor", "--unknown", "--json"], io);
    expect(jsonExit).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, command: "doctor" });
    expect(stdout.endsWith("\n")).toBe(true);
  });
});
