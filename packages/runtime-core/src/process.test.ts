// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vite-plus/test";
import { runManagedProcess } from "./process.ts";

const executable = process.execPath;

describe("managed child process", () => {
  it("returns output, exit code, and signal state", async () => {
    const result = await runManagedProcess({
      command: executable,
      args: ["-e", "process.stdout.write('ok'); process.stderr.write('note')"],
      platform: process.platform,
      timeoutMs: 5_000,
      maxOutputChars: 1_024,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "note",
      timedOut: false,
      aborted: false,
      outputTruncated: false,
    });
  });

  it("returns an actionable spawn failure", async () => {
    const result = await runManagedProcess({
      command: "holycodex-command-that-does-not-exist",
      args: [],
      platform: process.platform,
      timeoutMs: 5_000,
      maxOutputChars: 1_024,
    });

    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/ENOENT|not found/i);
    expect(result.timedOut).toBe(false);
  });

  it("rejects a relative working directory at the process boundary", async () => {
    await expect(
      runManagedProcess({
        command: executable,
        args: [],
        platform: process.platform,
        cwd: "relative",
        timeoutMs: 5_000,
        maxOutputChars: 1_024,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("terminates a timed-out process and preserves timeout state", async () => {
    const result = await runManagedProcess({
      command: executable,
      args: ["-e", "setInterval(() => {}, 1000)"],
      platform: process.platform,
      timeoutMs: 50,
      maxOutputChars: 1_024,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode !== 0 || result.signal !== null).toBe(true);
  });

  it("terminates an aborted process", async () => {
    const controller = new AbortController();
    const promise = runManagedProcess({
      command: executable,
      args: ["-e", "setInterval(() => {}, 1000)"],
      platform: process.platform,
      timeoutMs: 5_000,
      maxOutputChars: 1_024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50).unref();

    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("bounds output while preserving its beginning and end", async () => {
    const result = await runManagedProcess({
      command: executable,
      args: ["-e", "process.stdout.write('START' + 'x'.repeat(4096) + 'END')"],
      platform: process.platform,
      timeoutMs: 5_000,
      maxOutputChars: 128,
    });

    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toContain("START");
    expect(result.stdout).toContain("END");
    expect(result.stdout).toContain("diagnostic output truncated");
  });
});
