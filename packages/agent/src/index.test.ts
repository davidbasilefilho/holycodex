// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentBinary } from "./index.ts";

function io(cwd: string) {
  let stdout = "";
  let stderr = "";
  return {
    value: () => ({ stdout, stderr }),
    io: {
      cwd,
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    },
  };
}

describe("holycodex-agent", () => {
  test("supports equivalent side-effect-free help at every command depth", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "holycodex-agent-help-"));
    const paths: readonly (readonly string[])[] = [
      [],
      ["intent"],
      ["intent", "create"],
      ["intent", "list"],
      ["intent", "current"],
      ["intent", "read"],
      ["intent", "select"],
      ["intent", "transition"],
      ["intent", "evidence"],
      ["intent", "complete"],
      ["intent", "abandon"],
      ["plan"],
      ["plan", "read"],
      ["plan", "revise"],
      ["assignment"],
      ["assignment", "create"],
      ["assignment", "list"],
      ["assignment", "read"],
      ["assignment", "start"],
      ["assignment", "result"],
    ];
    for (const path of paths) {
      const short = io(cwd);
      expect(await runAgentBinary([...path, "-h"], short.io)).toBe(0);
      const long = io(cwd);
      expect(await runAgentBinary([...path, "--help"], long.io)).toBe(0);
      expect(long.value().stdout).toBe(short.value().stdout);
      expect(short.value().stderr).toBe("");
      expect(long.value().stderr).toBe("");
    }
    await expect(readdir(join(cwd, ".holycodex"))).rejects.toThrow();
  });

  test("returns a structured classified failure for invalid usage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "holycodex-agent-invalid-"));
    const captured = io(cwd);
    expect(await runAgentBinary(["intent", "list", "--unknown", "value"], captured.io)).toBe(2);
    expect(captured.value().stdout).toBe("");
    expect(JSON.parse(captured.value().stderr)).toMatchObject({
      schema_version: "holycodex-agent-response-1",
      ok: false,
      error: { code: "invalid_usage" },
    });
  });

  test("classifies malformed external argv through the Effect Schema boundary", async () => {
    const captured = io(await mkdtemp(join(tmpdir(), "holycodex-agent-argv-")));
    expect(
      await runAgentBinary(["intent", 42 as unknown as string] as readonly string[], captured.io),
    ).toBe(2);
    expect(JSON.parse(captured.value().stderr)).toMatchObject({
      schema_version: "holycodex-agent-response-1",
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});
