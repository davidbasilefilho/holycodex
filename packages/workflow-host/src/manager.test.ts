import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient, type AppServerTransport } from "./app-server";
import { safeChildPath, WorkflowManager } from "./manager";

function fakeClient(calls: string[]): CodexAppServerClient {
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
              ? { items: [{ type: "agent_message", text: '{"ok":true}' }] }
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
