// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { renderHuman, runCli, runBinary } from "./index.ts";

describe("human CLI presentation", () => {
  test("renders aligned success data without ANSI when output is not a TTY", async () => {
    const result = await runCli(["version"]);
    expect(
      renderHuman(result, { stdoutIsTTY: false, env: {} }).replace(
        /version: .+\n/u,
        "version: <version>\n",
      ),
    ).toMatchInlineSnapshot(`
      "✔ version
        version: <version>
      "
    `);
  });

  test("uses semantic ANSI only for interactive non-CI output", async () => {
    const result = await runCli(["version"]);
    const rendered = renderHuman(result, { stdoutIsTTY: true, env: {} });
    expect(rendered).toContain("\u001b[32m✔\u001b[0m");
    expect(renderHuman(result, { stdoutIsTTY: true, env: { NO_COLOR: "1" } })).not.toContain(
      "\u001b[",
    );
    expect(renderHuman(result, { stdoutIsTTY: true, env: { CI: "true" } })).not.toContain(
      "\u001b[",
    );
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
