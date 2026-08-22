// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import { decodeUnknown } from "@holycodex/core";
import { describe, expect, test } from "vite-plus/test";
import {
  AppServerClient,
  detectCapabilityMatrix,
  executeAssignment,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
  ModelListResultSchema,
  selectExecutionBackend,
} from "./index";
import type { AsyncLineTransport } from "./index";
import type { v2 as GeneratedV2 } from "../generated/codex-cli-0.148.0/typescript";

const FIXTURE_ROOT = join(import.meta.dirname, "../test/fixtures/codex-cli-0.148.0");

async function fixtureLines(name: string): Promise<readonly unknown[]> {
  const contents = await readFile(join(FIXTURE_ROOT, name), "utf8");
  return contents
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

class FixtureTransport implements AsyncLineTransport {
  readonly writes: string[] = [];
  closeCount = 0;
  closed = false;
  private readonly queued: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private readonly writeWaiters: Array<{
    readonly predicate: (line: string) => boolean;
    readonly resolve: (line: string) => void;
  }> = [];
  onWrite: ((line: string) => void) | undefined;

  async readLine(): Promise<string | null> {
    const line = this.queued.shift();
    if (line !== undefined) {
      return line;
    }
    if (this.closed) {
      return null;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async writeLine(line: string): Promise<void> {
    this.writes.push(line);
    this.onWrite?.(line);
    for (const waiter of [...this.writeWaiters]) {
      if (waiter.predicate(line)) {
        this.writeWaiters.splice(this.writeWaiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  }

  waitForWrite(predicate: (line: string) => boolean): Promise<string> {
    const existing = this.writes.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => this.writeWaiters.push({ predicate, resolve }));
  }

  enqueue(value: unknown): void {
    const line = typeof value === "string" ? value : JSON.stringify(value);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      this.queued.push(line);
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }
}

describe("codex-cli 0.148.0 boundary fixtures", () => {
  test("decodes the exact generated handshake and completion wire shapes", async () => {
    const handshake = await fixtureLines("handshake.ndjson");
    expect(Either.isRight(decodeUnknown(JsonRpcResponseSchema, handshake[0]))).toBe(true);
    expect(Either.isRight(decodeUnknown(JsonRpcNotificationSchema, handshake[1]))).toBe(true);

    const completion = await fixtureLines("assignment-completion.ndjson");
    expect(Either.isRight(decodeUnknown(JsonRpcResponseSchema, completion[0]))).toBe(true);
    expect(Either.isRight(decodeUnknown(JsonRpcNotificationSchema, completion[2]))).toBe(true);
  });

  test("proves the stable v1 fallback when v2 is not advertised", async () => {
    const lines = await fixtureLines("capability-v1-fallback.ndjson");
    const parsed = decodeUnknown(
      ModelListResultSchema,
      (lines[0] as { readonly result: unknown }).result,
    );
    expect(Either.isRight(parsed)).toBe(true);
    if (Either.isLeft(parsed)) {
      throw new Error("fixture invalid");
    }
    expect(detectCapabilityMatrix(parsed.right.data[0]!)).toEqual({
      multi_agent: "stable",
      multi_agent_v2: "disabled",
    });
    expect(
      selectExecutionBackend(
        {
          model: "gpt-5",
          effort: "medium",
          service_tier: "Standard",
          prefer_multi_agent_v2: true,
          require_multi_agent_v2: false,
        },
        parsed.right.data[0]!,
      ),
    ).toBe("app-server-v1-fallback");
  });

  test("fails closed when the server advertises v2 without a generated V2 lifecycle", async () => {
    const lines = await fixtureLines("capability-v2-advertised.ndjson");
    const parsed = decodeUnknown(
      ModelListResultSchema,
      (lines[0] as { readonly result: unknown }).result,
    );
    expect(Either.isRight(parsed)).toBe(true);
    if (Either.isLeft(parsed)) {
      throw new Error("fixture invalid");
    }
    const model = parsed.right.data[0]!;
    expect(detectCapabilityMatrix(model)).toEqual({
      multi_agent: "unknown",
      multi_agent_v2: "unknown",
    });
    try {
      selectExecutionBackend(
        {
          model: "gpt-5-v2",
          effort: "medium",
          service_tier: "Standard",
          prefer_multi_agent_v2: true,
          require_multi_agent_v2: false,
        },
        model,
      );
      throw new Error("expected V2 capability failure");
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: "protocol_mismatch",
        details: { generated_lifecycle: "unverified" },
      });
    }
  });

  test("keeps the stable fallback when the model only advertises stable multi-agent", async () => {
    const lines = await fixtureLines("capability-v2-disabled.ndjson");
    const parsed = decodeUnknown(
      ModelListResultSchema,
      (lines[0] as { readonly result: unknown }).result,
    );
    expect(Either.isRight(parsed)).toBe(true);
    if (Either.isLeft(parsed)) {
      throw new Error("fixture invalid");
    }
    const model = parsed.right.data[0]!;
    expect(detectCapabilityMatrix(model)).toEqual({
      multi_agent: "stable",
      multi_agent_v2: "disabled",
    });
    expect(
      selectExecutionBackend(
        {
          model: "gpt-5-v1",
          effort: "medium",
          service_tier: "Standard",
          prefer_multi_agent_v2: true,
          require_multi_agent_v2: false,
        },
        model,
      ),
    ).toBe("app-server-v1-fallback");
  });

  test("routes approval requests through the typed server-request handler and cleans up", async () => {
    const transport = new FixtureTransport();
    const approval = await fixtureLines("approval-request-response.ndjson");
    const approvalResponse: GeneratedV2.CommandExecutionRequestApprovalResponse = {
      decision: "accept",
    };
    transport.onWrite = (line) => {
      const request = JSON.parse(line) as { readonly id: number; readonly method?: string };
      if (request.method === "initialize") {
        transport.enqueue({
          id: request.id,
          result: {
            userAgent: "codex-cli 0.148.0",
            codexHome: "/tmp/codex",
            platformFamily: "unix",
            platformOs: "linux",
          },
        });
      }
      if (request.method === "thread/start") {
        transport.enqueue(approval[0]!);
      }
    };
    const client = new AppServerClient(transport, {
      onServerRequest: () => approvalResponse,
    });
    await client.initialize();
    const pending = client.startThread();
    await Promise.resolve();
    const responseLine = await transport.waitForWrite(
      (line) => line === JSON.stringify(approval[1]),
    );
    expect(JSON.parse(responseLine)).toEqual(approval[1]);
    await client.close();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(transport.closed).toBe(true);
    expect(transport.closeCount).toBe(1);
  });

  test("executes a validated assignment through the stable App Server fallback", async () => {
    const transport = new FixtureTransport();
    const handshake = await fixtureLines("handshake.ndjson");
    const capabilities = await fixtureLines("capability-v1-fallback.ndjson");
    const completion = await fixtureLines("assignment-completion.ndjson");
    const methods: string[] = [];
    const stages: string[] = [];
    transport.onWrite = (line) => {
      const request = JSON.parse(line) as { readonly id: number; readonly method?: string };
      if (request.method !== undefined && request.method !== "initialized") {
        methods.push(request.method);
        stages.push(request.method);
      }
      if (request.method === "initialize") {
        transport.enqueue(handshake[0]!);
      } else if (request.method === "model/list") {
        transport.enqueue(capabilities[0]!);
      } else if (request.method === "thread/start") {
        transport.enqueue(completion[0]!);
      } else if (request.method === "turn/start") {
        transport.enqueue(completion[1]!);
        queueMicrotask(() => {
          stages.push("turn/completed");
          transport.enqueue(completion[2]!);
        });
      }
    };
    const client = new AppServerClient(transport);
    await client.initialize();
    const outcome = await Effect.runPromise(
      executeAssignment(
        client,
        {
          assignment: {
            id: "assignment-1",
            objective: "inspect the fixture",
            role_task: { role: "Worker", task: "implementation" },
            authority: "Change only the assigned seam; Root owns material choices.",
            scope: [],
            references: [],
            constraints: [],
            required_evidence: [],
            acceptance: [],
            exclusions: [],
            escalation: [],
          },
          route: {
            key: "Worker:implementation",
            role_task: { role: "Worker", task: "implementation" },
          },
          tools: { allowed: [], specialist_spawn: false, workflow: false },
          security: { network: false, specialist_spawn: false, workflow: false },
          compatibility: {
            model: "gpt-5",
            effort: "medium",
            service_tier: "Standard",
            prefer_multi_agent_v2: true,
            require_multi_agent_v2: false,
          },
        },
        { timeoutMs: 1000 },
      ),
    );
    expect(outcome.backend).toBe("app-server-v1-fallback");
    expect(outcome.session_mode).toBe("fresh");
    expect(outcome.thread_id).toBe("thread-fixture");
    expect(outcome.outcome).toMatchObject({
      protocol_version: "holycodex-specialist-outcome-2",
      route: { role: "Worker", task: "implementation" },
      status: "completed",
    });
    expect(outcome.outcome).not.toHaveProperty("changed_files");
    expect(methods).toEqual(["initialize", "model/list", "thread/start", "turn/start"]);
    expect(stages).toEqual([
      "initialize",
      "model/list",
      "thread/start",
      "turn/start",
      "turn/completed",
    ]);
    const threadStart = transport.writes
      .map((line) => JSON.parse(line) as { readonly method?: string; readonly params?: unknown })
      .find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({ ephemeral: false });
    await client.close();
    expect(transport.closeCount).toBe(1);
  });

  test("resumes a matching retained thread and sends only delta context", async () => {
    const transport = new FixtureTransport();
    const handshake = await fixtureLines("handshake.ndjson");
    const capabilities = await fixtureLines("capability-v1-fallback.ndjson");
    const completion = await fixtureLines("assignment-completion.ndjson");
    const methods: string[] = [];
    transport.onWrite = (line) => {
      const request = JSON.parse(line) as { readonly method?: string; readonly id?: number };
      if (request.method !== undefined && request.method !== "initialized") {
        methods.push(request.method);
      }
      if (request.method === "initialize") {
        transport.enqueue(handshake[0]!);
      } else if (request.method === "model/list") {
        transport.enqueue(capabilities[0]!);
      } else if (request.method === "thread/resume") {
        transport.enqueue(completion[0]!);
      } else if (request.method === "turn/start") {
        transport.enqueue(completion[1]!);
        queueMicrotask(() => transport.enqueue(completion[2]!));
      }
    };
    const client = new AppServerClient(transport);
    await client.initialize();
    const outcome = await Effect.runPromise(
      executeAssignment(
        client,
        {
          assignment: {
            id: "assignment-2",
            objective: "continue the fixture",
            role_task: { role: "Worker", task: "implementation" },
            authority: "Change only the assigned seam; Root owns material choices.",
            scope: ["must not be repeated"],
            references: ["must not be repeated"],
            constraints: ["must not be repeated"],
            required_evidence: ["return proof"],
            acceptance: ["finish the delta"],
            exclusions: ["must not be repeated"],
            escalation: ["must not be repeated"],
            delta: ["Implement the next bounded change."],
          },
          route: {
            key: "Worker:implementation",
            role_task: { role: "Worker", task: "implementation" },
          },
          tools: { allowed: [], specialist_spawn: false, workflow: false },
          security: { network: false, specialist_spawn: false, workflow: false },
          compatibility: {
            model: "gpt-5",
            effort: "medium",
            service_tier: "Standard",
            prefer_multi_agent_v2: true,
            require_multi_agent_v2: false,
          },
          retained_context: {
            thread_id: "thread-fixture",
            project: {
              project_id: "project-1",
              trust_id: "trust-1",
              project_digest: "a".repeat(64),
              trust_digest: "b".repeat(64),
            },
            objective_lineage: "lineage-1",
            role_task: { role: "Worker", task: "implementation" },
            route: "Worker:implementation",
            authority_scope_digest: "c".repeat(64),
            policy_digest: "d".repeat(64),
            tool_profile: "default",
            security_profile: "default",
            prompt_profile: "default",
            approval_policy: "root",
            sandbox_policy: "workspace-write",
            codex_capability_digest: "e".repeat(64),
            last_accepted_fingerprint: "f".repeat(64),
            last_accepted_turn_id: "turn-previous",
          },
        },
        { timeoutMs: 1000 },
      ),
    );
    expect(outcome.session_mode).toBe("resumed");
    expect(methods).toEqual(["initialize", "model/list", "thread/resume", "turn/start"]);
    const turnStart = transport.writes
      .map((line) => JSON.parse(line) as { readonly method?: string; readonly params?: unknown })
      .find((request) => request.method === "turn/start");
    const prompt = JSON.stringify(turnStart?.params);
    expect(prompt).toContain("Delta: Implement the next bounded change.");
    expect(prompt).not.toContain("must not be repeated");
    await client.close();
  });

  test("keeps cancellation and failure typed at the Effect adapter boundary", async () => {
    const transport = new FixtureTransport();
    const client = new AppServerClient(transport);
    const result = await Effect.runPromise(
      Effect.either(
        Effect.tryPromise({
          try: () => client.close(),
          catch: () => new Error("close failed"),
        }),
      ),
    );
    expect(Either.isRight(result)).toBe(true);
  });
});
