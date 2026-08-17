// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  evaluateWorkflow as evaluateWorkflowProcess,
  type EvaluateWorkflowInput,
  type WorkflowChildProcess,
} from "./index.ts";
import {
  DEFAULT_WORKFLOW_LIMITS,
  parseProtocolLine,
  toWireLimits,
  WorkflowRuntimeError,
} from "./protocol.ts";

const cwd = process.cwd();
const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function bunChildSpawner(
  executable: string,
  entrypoint: string,
  childCwd: string,
): WorkflowChildProcess {
  if (!existsSync(childCwd)) throw new Error("test cwd does not exist");
  const child = spawn(executable, [entrypoint], {
    cwd: childCwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<{
    readonly exitCode: number | null;
    readonly errorCode: string | null;
  }>((resolve) => {
    let settled = false;
    child.once("error", (error: unknown) => {
      if (settled) return;
      settled = true;
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "unknown";
      resolve({ exitCode: null, errorCode: code });
    });
    child.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, errorCode: null });
    });
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    writeLine: async (line) => {
      if (!child.stdin) throw new Error("child stdin unavailable");
      if (!child.stdin.write(line)) await once(child.stdin, "drain");
    },
    kill: () => child.kill(),
  };
}

function evaluateWorkflow(
  input: Omit<EvaluateWorkflowInput, "testChildSpawner">,
): ReturnType<typeof evaluateWorkflowProcess> {
  return evaluateWorkflowProcess({ ...input, testChildSpawner: bunChildSpawner });
}

describe("workflow-runtime", () => {
  test("evaluates pure TypeScript with frozen JSON args and runtime projection", async () => {
    const result = await evaluateWorkflow({
      source: `
        type Input = { value: number };
        return {
          value: (args as Input).value,
          argsFrozen: Object.isFrozen(args),
          nestedFrozen: Object.isFrozen((args as Input & { nested: object }).nested),
          runtimeFrozen: Object.isFrozen(runtime),
        };
      `,
      args: { value: 7, nested: { stable: true } },
      runtime: { name: "runtime-test" },
      cwd,
      operationHandler: async () => null,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        value: 7,
        argsFrozen: true,
        nestedFrozen: true,
        runtimeFrozen: true,
      },
    });
  });

  test("supports default results and agent round trips", async () => {
    const result = await evaluateWorkflow({
      source: `export default await agent("hello", { channel: "test" });`,
      args: null,
      cwd,
      operationHandler: async (operation) => ({
        prompt: operation.prompt,
        options: operation.options,
      }),
    });

    expect(result).toEqual({
      ok: true,
      value: { prompt: "hello", options: { channel: "test" } },
    });
  });

  test("preserves pipeline order while bounding host concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const completionOrder: string[] = [];
    const result = await evaluateWorkflow({
      source: `return await pipeline(["a", "b", "c", "d"], { concurrency: 2 });`,
      args: {},
      cwd,
      operationHandler: async (operation) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await sleep(operation.prompt === "a" || operation.prompt === "c" ? 20 : 5);
        completionOrder.push(operation.prompt);
        active -= 1;
        return operation.prompt.toUpperCase();
      },
    });

    expect(result).toEqual({ ok: true, value: ["A", "B", "C", "D"] });
    expect(maximumActive).toBe(2);
    expect(completionOrder).not.toEqual(["a", "b", "c", "d"]);
  });

  test("rejects forbidden syntax before QuickJS evaluation", async () => {
    const sources = [
      `import x from "x"; return x;`,
      `return import("x");`,
      `return require("x");`,
      `return eval("1");`,
      `return Function("return 1")();`,
      `return WebAssembly;`,
      `enum Mode { One } return Mode.One;`,
      `namespace Hidden { export const value = 1 } return Hidden.value;`,
      `@decorator class Hidden {} return 1;`,
      `using resource = {}; return 1;`,
    ];

    for (const source of sources) {
      const result = await evaluateWorkflow({
        source,
        args: {},
        cwd,
        operationHandler: async () => null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("source_rejected");
      }
    }
  });

  test("closes reachable function constructor escapes", async () => {
    const sources = [
      `return Object.getPrototypeOf(async function () {}).constructor("return 1")();`,
      `return Object.getPrototypeOf(function* () {}).constructor("return 1")().next().value;`,
      `return Object.getPrototypeOf(async function* () {}).constructor("return 1")();`,
    ];

    for (const source of sources) {
      const result = await evaluateWorkflow({
        source,
        args: {},
        cwd,
        operationHandler: async () => null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["evaluation_failed", "source_rejected"]).toContain(result.error.code);
      }
    }
  });

  test("keeps the realm free of host globals", async () => {
    const result = await evaluateWorkflow({
      source: `return { bun: typeof globalThis["Bun"], process: typeof globalThis["process"], fetch: typeof globalThis["fetch"], req: typeof globalThis["require"], hostAgent: typeof globalThis["__hostAgent"], workflow: typeof globalThis["__workflow"], lexicalHost: typeof __hostAgent, lexicalLimits: typeof __workflowLimits };`,
      args: {},
      cwd,
      operationHandler: async () => null,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        bun: "undefined",
        process: "undefined",
        fetch: "undefined",
        req: "undefined",
        hostAgent: "undefined",
        workflow: "undefined",
        lexicalHost: "undefined",
        lexicalLimits: "undefined",
      },
    });
  });

  test("interrupts infinite synchronous work and enforces timeout", async () => {
    const interrupted = await evaluateWorkflow({
      source: `while (true) {}`,
      args: {},
      cwd,
      limits: { maxInterrupts: 100, wallTimeMs: 2_000 },
      operationHandler: async () => null,
    });
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) {
      expect(["interrupted", "timed_out"]).toContain(interrupted.error.code);
    }

    const timedOut = await evaluateWorkflow({
      source: `return await new Promise(() => {});`,
      args: {},
      cwd,
      limits: { wallTimeMs: 150 },
      operationHandler: async () => null,
    });
    expect(timedOut).toMatchObject({ ok: false, error: { code: "timed_out" } });
  });

  test("cancels an evaluation and sanitizes host handler errors", async () => {
    const controller = new AbortController();
    const cancelledPromise = evaluateWorkflow({
      source: `return await agent("wait");`,
      args: {},
      cwd,
      signal: controller.signal,
      operationHandler: async () => {
        await sleep(100);
        return null;
      },
    });
    setTimeout(() => controller.abort(), 20);
    const cancelled = await cancelledPromise;
    expect(cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });

    const failed = await evaluateWorkflow({
      source: `return await agent("secret");`,
      args: {},
      cwd,
      operationHandler: async () => {
        throw new Error("secret host credentials");
      },
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "operation_failed", message: "The workflow operation failed." },
    });
    if (!failed.ok) {
      expect(failed.error.message).not.toContain("credentials");
    }
  });

  test("rejects malformed, cyclic, oversized, and crashed boundaries", async () => {
    const malformedLimits = toWireLimits({ ...DEFAULT_WORKFLOW_LIMITS, maxLineBytes: 128 });
    expect(() => parseProtocolLine("{not-json}", { ...DEFAULT_WORKFLOW_LIMITS })).toThrow(
      WorkflowRuntimeError,
    );
    expect(() =>
      parseProtocolLine("x".repeat(129), { ...DEFAULT_WORKFLOW_LIMITS, maxLineBytes: 128 }),
    ).toThrow(WorkflowRuntimeError);
    expect(malformedLimits.max_line_bytes).toBe(128);

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const cyclicResult = await evaluateWorkflow({
      source: `return 1;`,
      args: cyclic,
      cwd,
      operationHandler: async () => null,
    });
    expect(cyclicResult).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const oversizedSource = await evaluateWorkflow({
      source: "return 1;",
      args: {},
      cwd,
      limits: { maxSourceBytes: 4 },
      operationHandler: async () => null,
    });
    expect(oversizedSource).toMatchObject({ ok: false, error: { code: "resource_limit" } });

    const oversizedResult = await evaluateWorkflow({
      source: `return await agent("big");`,
      args: {},
      cwd,
      limits: { maxResultBytes: 64 },
      operationHandler: async () => "x".repeat(100),
    });
    expect(oversizedResult).toMatchObject({ ok: false, error: { code: "operation_failed" } });

    const crashed = await evaluateWorkflow({
      source: `return 1;`,
      args: {},
      cwd: "/path/that/does/not/exist",
      operationHandler: async () => null,
    });
    expect(crashed).toMatchObject({ ok: false, error: { code: "child_crashed" } });
  });

  test("isolates repeated evaluations", async () => {
    const source = `return (globalThis.counter = (globalThis.counter ?? 0) + 1);`;
    const first = await evaluateWorkflow({
      source,
      args: {},
      cwd,
      operationHandler: async () => null,
    });
    const second = await evaluateWorkflow({
      source,
      args: {},
      cwd,
      operationHandler: async () => null,
    });
    expect(first).toEqual({ ok: true, value: 1 });
    expect(second).toEqual({ ok: true, value: 1 });
  });
});
