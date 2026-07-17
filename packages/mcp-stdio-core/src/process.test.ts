import { describe, expect, it } from "vitest";
import { killProcessTree, runManagedProcess } from "./process";

const platform = process.platform;
const executable = process.execPath;

describe("managed child process", () => {
  it("returns normal output and exit state", async () => {
    const result = await runManagedProcess({
      command: executable,
      args: ["-e", "process.stdout.write('ok'); process.stderr.write('note')"],
      platform,
      timeoutMs: 5_000,
      maxOutputChars: 1024,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "ok",
      stderr: "note",
      timedOut: false,
      matched: false,
      outputTruncated: false,
    });
  });

  it("settles once when spawning fails", async () => {
    const result = await runManagedProcess({
      command: "holycodex-command-that-does-not-exist",
      args: [],
      platform,
      timeoutMs: 5_000,
      maxOutputChars: 1024,
    });
    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/ENOENT|not found/i);
    expect(result.timedOut).toBe(false);
  });

  it("kills a timed-out process tree and preserves timeout state", async () => {
    const result = await runManagedProcess({
      command: executable,
      args: ["-e", "setInterval(() => {}, 1000)"],
      platform,
      timeoutMs: 50,
      maxOutputChars: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.matched).toBe(false);
  });

  it("escalates an ignored graceful timeout to a hard kill before settling", async () => {
    const signals: NodeJS.Signals[] = [];
    const result = await runManagedProcess(
      {
        command: executable,
        args: ["-e", "setInterval(() => {}, 1000)"],
        platform,
        timeoutMs: 10,
        maxOutputChars: 1024,
      },
      {
        terminationGraceMs: 0,
        kill(child, childPlatform, signal) {
          signals.push(signal);
          if (signal === "SIGKILL") killProcessTree(child, childPlatform, signal);
        },
      },
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.timedOut).toBe(true);
  });

  it("terminates after a success marker without double settlement", async () => {
    const result = await runManagedProcess({
      command: executable,
      args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      platform,
      timeoutMs: 5_000,
      maxOutputChars: 1024,
      matchOutput: (output) => output.includes("ready"),
    });
    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("ready");
  });

  it("caps output while preserving its beginning and end", async () => {
    const result = await runManagedProcess({
      command: executable,
      args: ["-e", "process.stdout.write('START' + 'x'.repeat(4096) + 'END')"],
      platform,
      timeoutMs: 5_000,
      maxOutputChars: 128,
    });
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toContain("START");
    expect(result.stdout).toContain("END");
    expect(result.stdout).toContain("diagnostic output truncated");
  });
});
