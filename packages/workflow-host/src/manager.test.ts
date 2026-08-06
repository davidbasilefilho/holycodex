import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient, type AppServerTransport } from "./app-server";
import { safeChildPath, WorkflowManager } from "./manager";

function fakeClient(calls: string[], responseText = '{"ok":true}'): CodexAppServerClient {
  const listeners = new Set<(message: unknown) => void>();
  const transport: AppServerTransport = {
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(line) {
      const request = JSON.parse(line) as Record<string, unknown>;
      const method = request.method;
      calls.push(String(method));
      const result =
        method === "thread/start"
          ? { thread: { id: "thread-1" } }
          : method === "turn/start"
            ? { turn: { id: "turn-1" } }
            : method === "thread/read"
              ? { items: [{ type: "agent_message", text: responseText }] }
              : {};
      for (const listener of listeners) listener({ id: request.id, result });
      if (method === "turn/start")
        for (const listener of listeners)
          listener({ method: "turn/completed", params: { threadId: "thread-1" } });
    },
  };
  return new CodexAppServerClient({ executable: "codex", transport });
}

describe("workflow manager", () => {
  it("reuses an exact completed replay and conceals child operational fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const calls: string[] = [];
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient(calls) });
      const script = 'export default await agent("secret prompt")';
      await manager.run({ script });
      await manager.run({ script });
      expect(calls.filter((method) => method === "turn/start")).toHaveLength(1);
      const journal = await readFile(
        join(
          directory,
          (await manager.list())[0]?.id ? `run-${(await manager.list())[0]?.id}.json` : "",
        ),
        "utf8",
      );
      expect(journal).not.toContain("transcript");
      expect(journal).not.toContain("system prompt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves exact structured agent results when replaying", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const calls: string[] = [];
      const manager = new WorkflowManager({
        storageDir: directory,
        client: fakeClient(calls, '{"next_token":"cursor","tokenCount":7,"ok":true}'),
      });
      const script = 'export default await agent("continue")';
      const first = await manager.run({ script });
      const replayed = await manager.run({ script });
      expect(replayed.result.result).toEqual(first.result.result);
      expect(replayed.result.result).toEqual({
        next_token: "cursor",
        tokenCount: 7,
        ok: true,
      });
      expect(calls.filter((method) => method === "turn/start")).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves exact invocation args when resuming", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const seen: unknown[] = [];
      const manager = new WorkflowManager({
        storageDir: directory,
        client: fakeClient([]),
        runner: async (input) => {
          seen.push(input.args);
          return { result: input.args ?? null, meta: null, events: [], errors: [] };
        },
      });
      const args = { prompt: "literal", tokenCount: 7, credentialType: "named" };
      const first = await manager.run({ script: "export default args", args });
      await manager.pause(first.id);
      const resumed = await manager.resume(first.id);
      expect(resumed.args).toEqual(args);
      expect(seen).toEqual([args, args]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not replay results across host policy changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const calls: string[] = [];
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient(calls) });
      const script = 'export default await agent("policy-sensitive")';
      await manager.run({ script, policy: { approvalPolicy: "on-request" } });
      await manager.run({ script, policy: { approvalPolicy: "never" } });
      expect(calls.filter((method) => method === "turn/start")).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("excludes lifecycle control files from run listings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient([]) });
      const run = await manager.run({ script: "export default null" });
      await manager.stopRun(run.id);
      expect(await manager.list()).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes a stop-call control from a separate manager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient([]) });
      const run = await manager.run({ script: "export default null" });
      const external = new WorkflowManager({ storageDir: directory, client: fakeClient([]) });
      const journal = await external.stopAgent(run.id, "7");
      const control = JSON.parse(
        await readFile(join(directory, `run-${run.id}.control.json`), "utf8"),
      ) as unknown;
      expect(control).toEqual({ action: "stop-call", callId: "7" });
      expect(journal.status).toBe("completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts each retry once per logical call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const manager = new WorkflowManager({
        storageDir: directory,
        client: fakeClient([]),
        runner: async (input) => {
          input.onEvent?.({ type: "call-start", callId: 1 });
          input.onEvent?.({ type: "call-error", callId: 1, attempt: 1, error: "retry" });
          input.onEvent?.({ type: "call-error", callId: 1, attempt: 2, error: "retry" });
          input.onEvent?.({ type: "call-complete", callId: 1, attempt: 3 });
          return { result: null, meta: null, events: [], errors: [] };
        },
      });
      const run = await manager.run({ script: "export default null" });
      expect(run.journal.metrics.retries).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors a final external stop control before completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const external = new WorkflowManager({ storageDir: directory, client: fakeClient([]) });
      const manager = new WorkflowManager({
        storageDir: directory,
        client: fakeClient([]),
        runner: async () => {
          const active = (await external.list())[0];
          if (active === undefined) throw new Error("Missing active workflow journal.");
          await external.stopRun(active.id);
          return { result: null, meta: null, events: [], errors: [] };
        },
      });
      const run = await manager.run({ script: "export default null" });
      expect(run.journal.status).toBe("cancelled");
      expect(run.journal.cancellation.requested).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for untrusted project execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const manager = new WorkflowManager({
        storageDir: directory,
        projectPath: directory,
        trusted: false,
        client: fakeClient([]),
      });
      await expect(manager.run({ script: "export default null" })).rejects.toThrow(/trust/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects workflow-authored host policy overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const calls: string[] = [];
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient(calls) });
      await expect(
        manager.run({
          script: 'export default await agent("unsafe", { approvalPolicy: "never", cwd: "/tmp" })',
        }),
      ).rejects.toThrow();
      expect(calls).not.toContain("thread/start");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves distinct routes for named agents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const calls: string[] = [];
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient(calls) });
      const result = await manager.run({
        script:
          'export default await pipeline(["explorer", "worker"], (agentName) => agent(agentName, { agent: agentName }))',
        routes: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          worker: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
        },
      });
      expect(result.result.result).toEqual([{ ok: true }, { ok: true }]);
      expect(calls.filter((method) => method === "turn/start")).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("selects an explicitly permitted stage escalation by route index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const calls: string[] = [];
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient(calls) });
      const result = await manager.run({
        script:
          'export default await agent("verify", { agent: "worker", stage: "verification", routeIndex: 1 })',
        routes: {
          worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          "worker:verification": { model: "gpt-5.6-luna", reasoningEffort: "high" },
          "worker:verification:1": { model: "gpt-5.6-luna", reasoningEffort: "max" },
        },
        permittedRoutes: {
          worker: [{ model: "gpt-5.6-luna", reasoningEffort: "max" }],
        },
      });
      expect(result.result.result).toEqual({ ok: true });
      expect(calls).toContain("turn/start");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unavailable stage route index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient([]) });
      const result = await manager.run({
        script:
          'export default await agent("verify", { agent: "worker", stage: "verification", routeIndex: 1 })',
        routes: {
          worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          "worker:verification": { model: "gpt-5.6-luna", reasoningEffort: "high" },
        },
      });
      expect(result.result.errors).toContain(
        "No permitted route index 1 for agent stage: worker:verification",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a plan route for unnamed agent calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const manager = new WorkflowManager({ storageDir: directory, client: fakeClient([]) });
      const result = await manager.run({
        script: 'export default await agent("unnamed")',
        routes: { worker: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" } },
      });
      expect(result.journal.status).toBe("failed");
      expect(result.result.errors).toContain(
        "A default plan route is required for unnamed agent calls.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves project trust checks for user-scoped saved workflows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    try {
      const manager = new WorkflowManager({
        storageDir: join(directory, "runs"),
        userSavedDir: join(directory, "saved"),
        projectPath: directory,
        trusted: false,
        client: fakeClient([]),
      });
      await manager.save("user-workflow", "export default null");
      await expect(manager.invokeSaved("user-workflow")).rejects.toThrow(/trust/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects traversal and symlink escapes from saved workflow roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holycodex-workflow-"));
    const outside = await mkdtemp(join(tmpdir(), "holycodex-workflow-outside-"));
    try {
      await mkdir(join(directory, "saved"), { recursive: true });
      await expect(safeChildPath(join(directory, "saved"), "../escape.js")).rejects.toThrow(
        /escape/i,
      );
      await symlink(outside, join(directory, "saved", "link"), "junction");
      await expect(safeChildPath(join(directory, "saved"), "link/escape.js")).rejects.toThrow(
        /escape/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
