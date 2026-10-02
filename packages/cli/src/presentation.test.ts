// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import { CLI_SCHEMA_VERSION } from "@holycodex/core";

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
    expect(topLevel).toContain("\u001b[1;38;2;122;162;247mHolyCodex\u001b[0m");
    expect(rendered).toContain("\u001b[1;38;2;122;162;247mUsage:\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;125;207;255m--sites\u001b[0m");
    expect(rendered).toContain("ChatGPT Sites (default: true).");
    expect(rendered).toContain("Browser Use (default: true).");
    expect(rendered).toContain("Computer Use plugins (default: false).");
    expect(renderHelp("install", { stdoutIsTTY: true, env: { NO_COLOR: "1" } })).not.toContain(
      "\u001b[",
    );
    expect(renderHelp("install", { stdoutIsTTY: true, env: { CI: "true" } })).not.toContain(
      "\u001b[",
    );
    expect(renderHelp("install", { stdoutIsTTY: false, env: {} })).not.toContain("\u001b[");
  });

  test("uses the Tokyo Night semantic palette for colored command output", () => {
    const result = {
      envelope: {
        schema_version: CLI_SCHEMA_VERSION,
        ok: true,
        command: "install",
        data: { warnings: ["review provider availability"] },
        warnings: [],
      },
      exitCode: 0,
    } as CommandResult;
    const rendered = renderHuman(result, { stdoutIsTTY: true, env: {} });
    expect(rendered).toContain("\u001b[1;38;2;122;162;247minstall\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;224;175;104mwarning\u001b[0m");
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
            profile: "default",
            tier: "standard",
            install_id: "private-id",
            digest: "private-digest",
            optional_selections: {
              sites: true,
              browser_use: true,
              computer_use: false,
            },
            capability_state: {
              frontend: { selected: true, status: "healthy" },
              security: { selected: true, status: "healthy" },
              sites: { selected: true, status: "healthy" },
              browser_use: { selected: true, status: "healthy" },
              computer_use: { selected: false, status: "disabled" },
              "session-audit": { selected: true, status: "healthy" },
              "auto-reset": { selected: true, status: "healthy" },
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
    expect(rendered).toContain("profile: default");
    expect(rendered).toContain(
      "capabilities: frontend, security, sites, browser_use, session-audit, auto-reset",
    );
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

  test("keeps the concrete invalid configuration in human and JSON error output", () => {
    const result = {
      envelope: {
        schema_version: CLI_SCHEMA_VERSION,
        ok: false,
        command: "install",
        error: {
          code: "invalid_configuration",
          message: "Codex configuration cannot be reconciled safely.",
          details: {
            path: "config.toml",
            key: "providers.local.command",
            issue: "configured executable was not found",
          },
        },
        warnings: [],
      },
      exitCode: 1,
    } as CommandResult;

    const human = renderHuman(result, { stdoutIsTTY: false, stderrIsTTY: false, env: {} });
    expect(human).toContain("path: config.toml");
    expect(human).toContain("key: providers.local.command");
    expect(human).toContain("issue: configured executable was not found");

    const json = JSON.stringify(result.envelope);
    expect(JSON.parse(json)).toMatchObject({
      ok: false,
      error: {
        details: {
          path: "config.toml",
          key: "providers.local.command",
          issue: "configured executable was not found",
        },
      },
    });
  });
});
