// SPDX-License-Identifier: Apache-2.0

import * as Effect from "effect/Effect";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  evaluateNativeWorkflowSource,
  hydrateWorkflowPlanIR,
  makeCapacityService,
  nativeWorkflowIdentityDigest,
  runExecutionPlan,
  type NativeWorkflow,
  type NativeWorkflowLimitsInput,
  type WorkflowPlanIR,
} from "./index.ts";

const numberWorkflow = `
import { createCodec, workflow, type ValueCodec } from "@holycodex/workflow-runtime";
const number = createCodec("number", (value: unknown): number => {
  if (typeof value !== "number") throw new Error("number expected");
  return value;
});
const first = workflow.step({
  id: "first",
  assignment: { input: number, output: number }
});
export default workflow.wait(first);
`;

async function load(source: string, limits?: NativeWorkflowLimitsInput): Promise<NativeWorkflow> {
  return limits === undefined
    ? await evaluateNativeWorkflowSource({ source })
    : await evaluateNativeWorkflowSource({ source, limits });
}

async function execute(native: NativeWorkflow, input: unknown): Promise<unknown> {
  const plan = await Effect.runPromise(hydrateWorkflowPlanIR(native));
  const capacity = await Effect.runPromise(makeCapacityService(plan.capacity));
  return await Effect.runPromise(
    runExecutionPlan(plan, input, {
      capacity,
      services: {
        agent: {
          execute: (assignment) => Effect.succeed(assignment.payload),
        },
      },
    }),
  );
}

async function signTestIR(ir: WorkflowPlanIR): Promise<WorkflowPlanIR> {
  const identityDigest = await nativeWorkflowIdentityDigest({
    abiVersion: ir.abiVersion,
    executionMode: ir.executionMode,
    sourceDigest: ir.sourceDigest,
    transformedDigest: ir.transformedDigest,
    graph: ir.graph,
    codecs: ir.codecs,
    capacityInputs: ir.capacityInputs,
    compileOptions: {},
  });
  return { ...ir, identityDigest };
}

describe("native workflow source boundary", () => {
  test("returns frozen inert IR and keeps source authority out of the host", async () => {
    const native = await load(numberWorkflow);
    try {
      expect(Object.isFrozen(native.ir)).toBe(true);
      expect(Object.isFrozen(native.ir.graph)).toBe(true);
      expect(native.ir.graph.nodes).toHaveLength(1);
      expect(native.ir.graph.nodes[0]?.assignment.inputCodecId).toBeDefined();
      await expect(execute(native, 7)).resolves.toBe(7);
    } finally {
      native.dispose();
    }
  });

  test.each([
    ["process", "export default process.env"],
    ["Bun", 'export default Bun.write("sentinel", "x")'],
    ["environment", 'export default Deno.env.get("HOME")'],
    ["filesystem", 'export default fs.writeFileSync("sentinel", "x")'],
    ["spawn", 'export default child_process.spawn("echo", [])'],
    ["fetch", 'export default fetch("https://example.invalid")'],
    ["WebSocket", 'export default new WebSocket("wss://example.invalid")'],
    ["require", 'export default require("node:fs")'],
    ["eval", 'export default eval("1")'],
    ["Function", 'export default Function("return 1")'],
    ["WebAssembly", "export default WebAssembly"],
    ["global leakage", "export default globalThis"],
    ["dynamic import", 'export default import("x")'],
    ["named export", "export const fallback = 1; export default 1"],
    ["non-Wait default", "export default 1"],
  ])("rejects %s before native execution", async (_name, source) => {
    await expect(load(source)).rejects.toMatchObject({ code: "source_rejected" });
  });

  test("rejects unexpected static imports and oversized transformed source", async () => {
    await expect(
      load('import { readFile } from "node:fs"; export default 1'),
    ).rejects.toMatchObject({ code: "source_rejected" });
    await expect(load(numberWorkflow, { maxTransformedBytes: 32 })).rejects.toMatchObject({
      code: "source_rejected",
    });
    await expect(load(numberWorkflow, { maxSourceBytes: 32 })).rejects.toMatchObject({
      code: "source_rejected",
    });
  });

  test("does not create a side-effect sentinel while rejecting authority", async () => {
    const sentinel = join(tmpdir(), `holycodex-native-${Date.now()}-${Math.random()}-sentinel`);
    try {
      await expect(
        load(`Bun.write(${JSON.stringify(sentinel)}, "created"); export default 1`),
      ).rejects.toMatchObject({ code: "source_rejected" });
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(sentinel, { force: true });
    }
  });

  test("interrupts infinite graph construction in QuickJS", async () => {
    await expect(
      load("while (true) {} export default 1", { wallTimeMs: 25, maxInterrupts: 32 }),
    ).rejects.toMatchObject({ code: "timed_out" });
  });

  test("rejects oversized graph and output data before compilation", async () => {
    const graphSource = `
      import { createCodec, workflow } from "@holycodex/workflow-runtime";
      const number = createCodec("number", (value: unknown): number => {
        if (typeof value !== "number") throw new Error("number expected");
        return value;
      });
      const a = workflow.step({ id: "a", assignment: { input: number, output: number } });
      const b = workflow.step({ id: "b", assignment: { input: number, output: number } });
      const c = workflow.step({ id: "c", assignment: { input: number, output: number } });
      export default workflow.wait({ a, b, c });
    `;
    await expect(load(graphSource, { maxPlanNodes: 2 })).rejects.toMatchObject({
      code: "resource_limit",
    });
    await expect(
      load(
        `
          import { createCodec, workflow } from "@holycodex/workflow-runtime";
          const text = createCodec("text", (value) => String(value));
          const step = workflow.step({ id: "large", assignment: { payload: "123456789", input: text, output: text } });
          export default workflow.wait(step);
        `,
        { maxStringBytes: 4 },
      ),
    ).rejects.toMatchObject({ code: "resource_limit" });
  });

  test("keeps codec decoder failures and timeouts inside the sandbox", async () => {
    const failing = await load(`
      import { createCodec, workflow } from "@holycodex/workflow-runtime";
      const number = createCodec("number", () => { throw new Error("decoder failure"); });
      const step = workflow.step({ id: "failure", assignment: { input: number, output: number } });
      export default workflow.wait(step);
    `);
    try {
      const codec = failing.codecs.get("codec-1");
      if (codec === undefined) throw new Error("test codec was not registered");
      expect(() => codec.decode(1)).toThrowError(/codec decoder failed/u);
    } finally {
      failing.dispose();
    }

    const timedOut = await load(
      `
        import { createCodec, workflow } from "@holycodex/workflow-runtime";
        const number = createCodec("number", () => { while (true) {} });
        const step = workflow.step({ id: "timeout", assignment: { input: number, output: number } });
        export default workflow.wait(step);
      `,
      { wallTimeMs: 25, maxInterrupts: 32 },
    );
    try {
      const codec = timedOut.codecs.get("codec-1");
      if (codec === undefined) throw new Error("test codec was not registered");
      expect(() => codec.decode(1)).toThrowError(/timed out/u);
    } finally {
      timedOut.dispose();
    }
  });

  test("executes typed queued and parallel graphs through the existing Effect runtime", async () => {
    const source = `
      import { createCodec, workflow } from "@holycodex/workflow-runtime";
      const number = createCodec("number", (value: unknown): number => {
        if (typeof value !== "number") throw new Error("number expected");
        return value;
      });
      const first = workflow.step({ id: "first", assignment: { input: number, output: number } });
      const queued = workflow.queue(first, (value: number) => workflow.step({
        id: "second",
        assignment: {
          payload: value,
          input: number,
          output: number,
          metadata: {
            when: { source: "first", path: [], equals: 5 },
            repeatUntil: { path: [], equals: 5 }
          }
        }
      }));
      const left = workflow.step({ id: "left", assignment: { input: number, output: number } });
      const right = workflow.step({ id: "right", assignment: { input: number, output: number } });
      export default workflow.wait({ queued, left, right });
    `;
    const native = await load(source);
    try {
      await expect(execute(native, 5)).resolves.toEqual({ queued: 5, left: 5, right: 5 });
    } finally {
      native.dispose();
    }
  });

  test("type-checks portable Effect schemas and variadic queues without a stage ceiling", async () => {
    const stages = Array.from(
      { length: 9 },
      (_, index) => `(value: number) => workflow.step({
        id: "stage-${index + 1}",
        assignment: { payload: value, input: number, output: number }
      })`,
    ).join(",\n");
    const native = await load(`
      import { createCodec, workflow } from "@holycodex/workflow";
      import * as Schema from "effect/Schema";
      const number = createCodec("number", Schema.Number);
      const first = workflow.step({ id: "stage-0", assignment: { input: number, output: number } });
      const queued = workflow.queue(first, ${stages});
      export default workflow.wait(queued);
    `);
    try {
      expect(native.ir.graph.nodes).toHaveLength(10);
      await expect(execute(native, 5)).resolves.toBe(5);
    } finally {
      native.dispose();
    }
  });

  test("rejects a queue whose next stage has the wrong input type", async () => {
    await expect(
      load(`
        import { createCodec, workflow } from "@holycodex/workflow";
        import * as Schema from "effect/Schema";
        const number = createCodec("number", Schema.Number);
        const text = createCodec("text", Schema.String);
        const first = workflow.step({ id: "first", assignment: { input: number, output: number } });
        const invalid = workflow.queue(first, (value: string) => workflow.step({
          id: "invalid",
          assignment: { payload: value, input: text, output: text }
        }));
        export default workflow.wait(invalid);
      `),
    ).rejects.toMatchObject({ code: "source_rejected" });
  });

  test("preserves compiler writer ownership and codec failures", async () => {
    const source = `
      import { createCodec, workflow } from "@holycodex/workflow-runtime";
      const number = createCodec("number", (value: unknown): number => {
        if (typeof value !== "number") throw new Error("bad codec");
        return value;
      });
      const left = workflow.step({ id: "left", assignment: { input: number, output: number, metadata: { writes: ["same"] } } });
      const right = workflow.step({ id: "right", assignment: { input: number, output: number, metadata: { writes: ["same"] } } });
      export default workflow.wait({ left, right });
    `;
    const native = await load(source);
    try {
      await expect(
        Effect.runPromise(Effect.flip(hydrateWorkflowPlanIR(native))),
      ).resolves.toMatchObject({ code: "compilation" });
    } finally {
      native.dispose();
    }
  });

  test("rejects invalid dependency and cycle declarations at hydration", async () => {
    const native = await load(numberWorkflow);
    try {
      const node = native.ir.graph.nodes[0];
      if (node === undefined) throw new Error("test node was not emitted");
      const invalidDependency = await signTestIR({
        ...native.ir,
        graph: {
          ...native.ir.graph,
          nodes: [{ ...node, dependencies: ["missing-node"] }],
        },
      });
      await expect(
        Effect.runPromise(Effect.flip(hydrateWorkflowPlanIR({ ...native, ir: invalidDependency }))),
      ).resolves.toMatchObject({ code: "compilation" });

      const cycle = await signTestIR({
        ...native.ir,
        graph: {
          ...native.ir.graph,
          nodes: [{ ...node, dependencies: [node.id] }],
        },
      });
      await expect(
        Effect.runPromise(Effect.flip(hydrateWorkflowPlanIR({ ...native, ir: cycle }))),
      ).resolves.toMatchObject({ code: "compilation" });
    } finally {
      native.dispose();
    }
  });

  test("rejects a native IR with a forged producer identity", async () => {
    const native = await load(numberWorkflow);
    try {
      const tampered = { ...native.ir, identityDigest: "0".repeat(64) };
      await expect(
        Effect.runPromise(Effect.flip(hydrateWorkflowPlanIR({ ...native, ir: tampered }))),
      ).resolves.toMatchObject({ code: "validation" });
    } finally {
      native.dispose();
    }
  });
});
