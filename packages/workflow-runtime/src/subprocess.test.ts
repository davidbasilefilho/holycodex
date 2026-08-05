import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runWorkflowInSubprocess } from "./subprocess";

describe("isolated workflow subprocess", () => {
  it("bridges agent requests without inheriting host credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-evaluator-"));
    const workerPath = join(directory, "worker.mjs");
    try {
      await writeFile(
        workerPath,
        `
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "start") {
    process.stdout.write(JSON.stringify({ type: "agent", id: 1, prompt: "hello", options: {} }) + "\\n");
  } else if (message.type === "agent-result") {
    process.stdout.write(JSON.stringify({
      type: "result",
      result: { result: { value: message.result, env: Object.keys(process.env) }, meta: null, events: [], errors: [] }
    }) + "\\n");
  }
});
`,
        "utf8",
      );
      const result = await runWorkflowInSubprocess(
        { script: "return agent('hello')", executor: async () => "done" },
        { executable: process.execPath, workerPath },
      );
      expect(result.result).toMatchObject({ value: "done" });
      expect(JSON.stringify(result.result)).not.toContain("CODEX");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates the evaluator when cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-evaluator-"));
    const workerPath = join(directory, "worker.mjs");
    try {
      await writeFile(workerPath, "setInterval(() => {}, 1000);\n", "utf8");
      const controller = new AbortController();
      const pending = runWorkflowInSubprocess(
        { script: "return null", executor: async () => null, signal: controller.signal },
        { executable: process.execPath, workerPath },
      );
      controller.abort();
      await expect(pending).rejects.toThrow(/cancel/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not start a workflow with a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;
    await expect(
      runWorkflowInSubprocess(
        {
          script: "return null",
          executor: async () => {
            executed = true;
            return null;
          },
          signal: controller.signal,
        },
        { executable: process.execPath, workerPath: "unused-worker.mjs" },
      ),
    ).rejects.toThrow(/cancel/i);
    expect(executed).toBe(false);
  });
});
