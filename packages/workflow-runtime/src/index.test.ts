import { describe, expect, it } from "vitest";

import { runWorkflow } from "./index";

describe("workflow runtime", () => {
  it("executes agent calls and returns exported metadata", async () => {
    let selectedAgent: string | undefined;
    const result = await runWorkflow({
      script: `export const meta = { phase: "demo" }; export default await agent("hello", { agent: "explorer", label: "greet" });`,
      executor: async (prompt, options) => {
        selectedAgent = options.agent;
        return { prompt, ok: true };
      },
    });
    expect(result.result).toEqual({ prompt: "hello", ok: true });
    expect(result.meta).toEqual({ phase: "demo" });
    expect(selectedAgent).toBe("explorer");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow-start",
      "call-start",
      "call-complete",
      "workflow-complete",
    ]);
  });

  it("supports top-level return with exported metadata", async () => {
    const result = await runWorkflow({
      script: `export const meta = { name: "return-style" }; return agent("hello");`,
      executor: async () => "done",
    });
    expect(result.result).toBe("done");
    expect(result.meta).toEqual({ name: "return-style" });
  });

  it("ignores export syntax inside return-style comments and prompts", async () => {
    const prompt = `Review this code:\nexport default function example() {}\nexport const meta = { name: "literal" };`;
    const result = await runWorkflow({
      script: `// review an export default declaration
        return agent(${JSON.stringify(prompt)});`,
      executor: async (prompt) => prompt,
    });
    expect(result.result).toBe(prompt);
  });

  it("provides args and preserves pipeline order while bounding calls", async () => {
    const prompts: string[] = [];
    const result = await runWorkflow({
      args: { values: [1, 2, 3] },
      script: `export default pipeline(args.values, (value) => agent(String(value)), { concurrency: 2 });`,
      executor: async (prompt) => {
        prompts.push(prompt);
        return Number(prompt) * 2;
      },
      limits: { maxConcurrency: 2 },
    });
    expect(result.result).toEqual([2, 4, 6]);
    expect(prompts).toEqual(["1", "2", "3"]);
  });

  it("applies pipeline metadata while preserving child overrides", async () => {
    const options: { readonly label?: string; readonly phase?: string }[] = [];
    const result = await runWorkflow({
      script: `export default pipeline(["first", "second"], item =>
        agent(item, item === "second" ? { label: "child" } : {}),
        { label: "batch", phase: "verification" });`,
      executor: async (_prompt, agentOptions) => {
        options.push(agentOptions);
        return null;
      },
    });
    expect(options).toEqual([
      { callId: 1, label: "batch", phase: "verification" },
      { callId: 2, label: "child", phase: "verification" },
    ]);
    expect(result.events.filter((event) => event.type === "call-start")).toEqual([
      { type: "call-start", callId: 1, label: "batch", phase: "verification" },
      { type: "call-start", callId: 2, label: "child", phase: "verification" },
    ]);
  });

  it("records retries and partial null failures", async () => {
    let calls = 0;
    const result = await runWorkflow({
      script: `export default pipeline(["ok", "bad"], (item) => agent(item, { retries: 1 }));`,
      executor: async (prompt) => {
        calls += 1;
        if (prompt === "bad") throw new Error("rejected");
        return null;
      },
    });
    expect(result.result).toEqual([null, null]);
    expect(calls).toBe(3);
    expect(result.errors).toEqual(["rejected"]);
  });

  it("keeps call ids stable across retries", async () => {
    const callIds: (number | undefined)[] = [];
    const result = await runWorkflow({
      script: `export default agent("retry", { retries: 2 });`,
      executor: async (_prompt, options) => {
        callIds.push(options.callId);
        if (callIds.length < 3) throw new Error("retry");
        return "done";
      },
    });
    expect(result.result).toBe("done");
    expect(callIds).toEqual([1, 1, 1]);
  });

  it("does not retry stopped agent calls", async () => {
    let calls = 0;
    const result = await runWorkflow({
      script: `export default agent("stop", { retries: 2 });`,
      executor: async () => {
        calls += 1;
        throw new Error("Agent call cancelled.");
      },
    });
    expect(result.result).toBeNull();
    expect(calls).toBe(1);
    expect(result.events).toContainEqual({
      type: "call-failed",
      callId: 1,
      attempts: 1,
    });
  });

  it("rejects non-isolated imports and validates structured output", async () => {
    await expect(
      runWorkflow({
        script: `export default await import("node:fs");`,
        executor: async () => null,
      }),
    ).rejects.toThrow();

    const result = await runWorkflow({
      script: `export default await agent("typed", { schema: { type: "object", required: ["id"] } });`,
      executor: async () => ({ bad: true }),
    });
    expect(result.result).toBeNull();
    expect(result.errors.length).toBe(1);
  });

  it("enforces pipeline fan-out and execution bounds", async () => {
    await expect(
      runWorkflow({
        script: `export default pipeline([1, 2], value => agent(String(value)));`,
        executor: async () => null,
        limits: { maxFanOut: 1 },
      }),
    ).rejects.toThrow(/fan-out/i);

    await expect(
      runWorkflow({
        script: `while (true) {}`,
        executor: async () => null,
        limits: { maxLoopIterations: 1 },
      }),
    ).rejects.toThrow();
  });
});
