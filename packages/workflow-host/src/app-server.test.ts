import { describe, expect, it } from "vitest";

import { CodexAppServerClient, type AppServerTransport } from "./app-server";

describe("Codex App Server client", () => {
  it("speaks JSONL lifecycle and injects route policy", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const requests: Record<string, unknown>[] = [];
    const transport: AppServerTransport = {
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send(line) {
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        const method = request.method;
        const result =
          method === "thread/start"
            ? { thread: { id: "thread-1" } }
            : method === "turn/start"
              ? { turn: { id: "turn-1" } }
              : method === "thread/read"
                ? {
                    items: [{ type: "agentMessage", text: '{"ok":true}' }],
                    usage: { inputTokens: 2, outputTokens: 3 },
                  }
                : {};
        for (const listener of listeners) listener({ id: request.id, result });
        if (method === "turn/start")
          queueMicrotask(() => {
            for (const listener of listeners)
              listener({
                method: "turn/completed",
                params: { threadId: "thread-1", usage: { inputTokens: 2, outputTokens: 3 } },
              });
          });
      },
    };
    const client = new CodexAppServerClient({ executable: "codex", transport });
    const execution = await client.execute("ignored", {
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      serviceTier: "fast",
      cwd: "/project",
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspace-write" },
      lowVerbosity: true,
      context: { finding: "example" },
      schema: { type: "object", required: ["ok"] },
    });
    expect(execution.result).toEqual({ ok: true });
    expect(execution.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "thread/read",
    ]);
    expect(requests[2]?.params).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "high",
      serviceTier: "fast",
      cwd: "/project",
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspace-write" },
      config: { model_verbosity: "low" },
    });
    const turnInput =
      (requests[3]?.params as { input?: { text?: string }[] } | undefined)?.input?.[0]?.text ?? "";
    expect(turnInput).toContain('{"finding":"example"}');
    expect(turnInput).toContain('{"type":"object","required":["ok"]}');
    await client.turnInterrupt("thread-1", "turn-1");
    await client.threadReopen("thread-1");
    expect(requests.map((request) => request.method)).toContain("turn/interrupt");
    expect(requests.map((request) => request.method)).toContain("thread/resume");
  });

  it("disposes the completion wait when turn start fails", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const transport: AppServerTransport = {
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send(line) {
        const request = JSON.parse(line) as Record<string, unknown>;
        const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : {};
        for (const listener of listeners)
          listener(
            request.method === "turn/start"
              ? { id: request.id, error: "turn start rejected" }
              : { id: request.id, result },
          );
      },
    };
    const client = new CodexAppServerClient({
      executable: "codex",
      transport,
      requestTimeoutMs: 10,
    });
    await expect(client.execute("ignored")).rejects.toThrow("turn start rejected");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close();
  });

  it("does not start a turn when cancelled during thread start", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const methods: unknown[] = [];
    const controller = new AbortController();
    const transport: AppServerTransport = {
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send(line) {
        const request = JSON.parse(line) as Record<string, unknown>;
        methods.push(request.method);
        if (request.method === "thread/start") controller.abort();
        for (const listener of listeners)
          listener({
            id: request.id,
            result: request.method === "thread/start" ? { thread: { id: "thread-1" } } : {},
          });
      },
    };
    const client = new CodexAppServerClient({ executable: "codex", transport });
    await expect(client.execute("ignored", { signal: controller.signal })).rejects.toThrow(
      /cancel/i,
    );
    expect(methods).not.toContain("turn/start");
    await client.close();
  });
});
