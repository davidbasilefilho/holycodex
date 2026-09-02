// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSha256Digest, decodeUnknown } from "@holycodex/core";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vite-plus/test";
import {
  AppServerClient,
  createOfficialPluginAdapter,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
  LiveOfficialPluginListEnvelopeSchema,
  OfficialPluginAdapterError,
  OfficialPluginManifestSchema,
  SupportedUsageSchema,
  TurnStartParamsSchema,
  createAllowlistedEnvironment,
  createManagedConfigState,
  discoverCodexExecutable,
  generateCodexSchemas,
  mergeManagedConfig,
  cleanupManagedConfig,
  parseLiveOfficialPluginList,
  parseOfficialPluginManifest,
  sanitizeDiagnostics,
  selectOfficialPlugins,
} from "./index";
import type { AsyncLineTransport } from "./index";

function decode<T>(schema: Schema.Schema<T>, input: unknown): Either.Either<T, unknown> {
  return decodeUnknown(schema, input);
}

type WriteHandler = (line: string) => void | Promise<void>;

class FakeTransport implements AsyncLineTransport {
  readonly lines: string[] = [];
  closeCount = 0;
  private readonly queued: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;
  onWrite: WriteHandler | undefined;

  async readLine(): Promise<string | null> {
    const queued = this.queued.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.closed) {
      return null;
    }
    return new Promise<string | null>((resolve) => this.waiters.push(resolve));
  }

  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
    await this.onWrite?.(line);
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

function requestFromLine(line: string): {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
} {
  const parsed: unknown = JSON.parse(line) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("not a request");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record["id"] !== "number" || typeof record["method"] !== "string") {
    throw new Error("not a request");
  }
  return { id: record["id"], method: record["method"], params: record["params"] };
}

function response(id: number, result: unknown): unknown {
  return { id, result };
}

function errorResponse(id: number, code: number, message: string): unknown {
  return { id, error: { code, message } };
}

const initializeResult = {
  userAgent: "codex-cli 0.148.0",
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "linux",
  serverInfo: { name: "codex", version: "0.148.0" },
};

function createInitializedClient(
  handler: (
    transport: FakeTransport,
    request: { readonly id: number; readonly method: string; readonly params?: unknown },
  ) => void,
): { readonly client: AppServerClient; readonly transport: FakeTransport } {
  const transport = new FakeTransport();
  transport.onWrite = (line) => {
    if (line.includes('"method":"initialized"')) {
      return;
    }
    handler(transport, requestFromLine(line));
  };
  return { client: new AppServerClient(transport), transport };
}

describe("Codex App Server schemas", () => {
  test("validate JSON-RPC responses, notifications, and complete usage", () => {
    expect(Either.isRight(decode(JsonRpcResponseSchema, response(1, { ok: true })))).toBe(true);
    expect(Either.isRight(decode(JsonRpcResponseSchema, errorResponse(1, -32001, "busy")))).toBe(
      true,
    );
    expect(
      Either.isRight(
        decode(JsonRpcNotificationSchema, {
          method: "turn/started",
          params: { threadId: "t" },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isRight(
        decode(SupportedUsageSchema, {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
        }),
      ),
    ).toBe(true);
    expect(Either.isRight(decode(SupportedUsageSchema, { inputTokens: 1 }))).toBe(true);
    expect(
      Either.isRight(
        decode(SupportedUsageSchema, {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        }),
      ),
    ).toBe(true);
  });

  test("require turn input while preserving inherited approval and sandbox fields", () => {
    const params = {
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspace-write" },
    };
    expect(Either.isRight(decode(TurnStartParamsSchema, params))).toBe(true);
    expect(Either.isRight(decode(TurnStartParamsSchema, { threadId: "thread-1" }))).toBe(false);
  });
});

describe("AppServerClient", () => {
  test("performs initialize once and sends initialized after the result", async () => {
    const { client, transport } = createInitializedClient((fake, request) => {
      expect(request.method).toBe("initialize");
      fake.enqueue(response(request.id, initializeResult));
    });

    const result = await client.initialize();
    expect(result.serverInfo?.["name"]).toBe("codex");
    expect(transport.lines).toHaveLength(2);
    expect(transport.lines[1]).toContain('"method":"initialized"');
    await expect(client.initialize()).resolves.toEqual(result);
    await client.close();
  });

  test("correlates concurrent calls across interleaved notifications", async () => {
    const events: unknown[] = [];
    const { client } = createInitializedClient((fake, request) => {
      if (request.method === "initialize") {
        fake.enqueue(response(request.id, initializeResult));
        return;
      }
      if (request.method === "thread/start") {
        fake.enqueue({ method: "thread/updated", params: { token: "secret" } });
        fake.enqueue(response(request.id, { thread: { id: "thread-1" } }));
        return;
      }
      fake.enqueue(response(request.id, { data: [{ id: "thread-2" }] }));
    });
    client.onNotification((notification) => events.push(notification));
    await client.initialize();
    const first = client.startThread();
    const second = client.listThreads();
    await expect(first).resolves.toMatchObject({ thread: { id: "thread-1" } });
    await expect(second).resolves.toMatchObject({ data: [{ id: "thread-2" }] });
    expect(events).toEqual([
      { kind: "unknown", method: "thread/updated", metadata: { params: { token: "secret" } } },
    ]);
    await client.close();
  });

  test("supports thread and turn actions", async () => {
    const methods: string[] = [];
    const { client } = createInitializedClient((fake, request) => {
      methods.push(request.method);
      if (request.method === "initialize") {
        fake.enqueue(response(request.id, initializeResult));
      } else if (request.method === "thread/list") {
        fake.enqueue(response(request.id, { threads: [{ id: "thread-1" }] }));
      } else if (request.method === "thread/read") {
        fake.enqueue(response(request.id, { thread: { id: "thread-1" }, items: [] }));
      } else if (request.method === "turn/start") {
        fake.enqueue(response(request.id, { turnId: "turn-1" }));
      } else if (request.method === "turn/interrupt") {
        fake.enqueue(response(request.id, { ok: true, turnId: "turn-1" }));
      } else if (request.method === "thread/unsubscribe") {
        fake.enqueue(response(request.id, { status: "unsubscribed" }));
      } else {
        fake.enqueue(response(request.id, { thread: { id: "thread-1" } }));
      }
    });
    await client.initialize();
    await client.startThread({ approvalPolicy: "never", sandboxPolicy: { type: "read-only" } });
    await client.resumeThread("thread-1");
    await client.readThread("thread-1");
    await client.listThreads();
    await client.forkThread("thread-1");
    await client.unsubscribeThread("thread-1");
    await client.startTurn({ threadId: "thread-1", prompt: "continue" });
    await client.interruptTurn("thread-1", "turn-1");
    expect(methods).toEqual([
      "initialize",
      "thread/start",
      "thread/resume",
      "thread/read",
      "thread/list",
      "thread/fork",
      "thread/unsubscribe",
      "turn/start",
      "turn/interrupt",
    ]);
    await client.close();
  });

  test("rejects malformed results and classifies overload errors as retryable", async () => {
    let overload = false;
    const { client } = createInitializedClient((fake, request) => {
      if (request.method === "initialize") {
        fake.enqueue(response(request.id, initializeResult));
      } else if (overload) {
        fake.enqueue(errorResponse(request.id, -32001, "server busy"));
      } else {
        fake.enqueue(response(request.id, { wrong: true }));
      }
    });
    await client.initialize();
    await expect(client.startThread()).rejects.toMatchObject({ code: "invalid_external_data" });
    overload = true;
    await expect(client.startThread()).rejects.toMatchObject({
      code: "server_error",
      retryable: true,
      details: { retryable: true, serverCode: -32001 },
    });
    await client.close();
  });

  test("bounds an unresponsive App Server request", async () => {
    const { transport } = createInitializedClient((fake, request) => {
      if (request.method === "initialize") {
        fake.enqueue(response(request.id, initializeResult));
      }
    });
    const timedClient = new AppServerClient(transport, { requestTimeoutMs: 25 });
    await timedClient.initialize();
    await expect(timedClient.startThread()).rejects.toMatchObject({ code: "timeout" });
    await timedClient.close();
  });

  test("fails bounded malformed lines and unsupported server requests", async () => {
    const transport = new FakeTransport();
    transport.onWrite = (line) => {
      if (line.includes('"method":"initialized"')) {
        return;
      }
      const request = requestFromLine(line);
      if (request.method === "initialize") {
        transport.enqueue(response(request.id, initializeResult));
      }
    };
    const client = new AppServerClient(transport, { maxLineBytes: 256 });
    await client.initialize();
    const action = client.startThread();
    transport.enqueue("x".repeat(300));
    await expect(action).rejects.toMatchObject({ code: "invalid_transport_line" });
    await client.close();
    expect(transport.closeCount).toBe(1);

    const secondTransport = new FakeTransport();
    secondTransport.onWrite = (line) => {
      if (line.includes('"method":"initialized"')) {
        return;
      }
      const request = requestFromLine(line);
      if (request.method === "initialize") {
        secondTransport.enqueue(response(request.id, initializeResult));
      }
    };
    const secondClient = new AppServerClient(secondTransport);
    await secondClient.initialize();
    await expect(secondClient.call("unsupported method", {})).rejects.toMatchObject({
      code: "invalid_external_data",
    });
    const pending = secondClient.startThread();
    secondTransport.enqueue({ id: 9, method: "server/request", params: {} });
    secondTransport.enqueue(response(2, { thread: { id: "thread-2" } }));
    await expect(pending).resolves.toEqual({ thread: { id: "thread-2" } });
    expect(secondTransport.lines).toContainEqual(
      JSON.stringify({ id: 9, error: { code: -32601, message: "No handler for server/request." } }),
    );
    await secondClient.close();
  });
});

describe("Codex identity, configuration, and plugins", () => {
  test("preserves unrelated keys and later user edits during managed cleanup", () => {
    const metadata = { owner: "holycodex" as const, schema: "0.15", installId: "install-1" };
    const initial = createManagedConfigState({ unrelated: "keep", managed: "original" });
    const merged = mergeManagedConfig(initial, { managed: "managed-value", added: true }, metadata);
    const userEdited = { ...merged, values: { ...merged.values, managed: "user-value" } };
    const cleaned = cleanupManagedConfig(userEdited, metadata);
    expect(cleaned.state.values).toEqual({ unrelated: "keep", managed: "user-value" });
    expect(cleaned.state.managed).toEqual({});
    expect(cleaned.preservedKeys).toEqual(["managed"]);
    const restored = cleanupManagedConfig(merged, metadata);
    expect(restored.state.values).toEqual({ unrelated: "keep", managed: "original" });
    expect(restored.restoredKeys).toEqual(["managed", "added"]);
  });

  test("rejects MCP declarations and requires explicit official selections", () => {
    const manifest = {
      name: "official-tool",
      version: "1.0.0",
      description: "An official tool",
    };
    expect(Either.isRight(decode(OfficialPluginManifestSchema, manifest))).toBe(true);
    expect(parseOfficialPluginManifest({ ...manifest, mcpServers: {} }).ok).toBe(false);
    expect(selectOfficialPlugins([manifest], [])).toEqual([]);
    expect(selectOfficialPlugins([manifest], [{ id: "official-tool", selected: true }])).toEqual([
      { manifest, explicitlySelected: true },
    ]);
  });

  test("parses the live plugin envelope without treating entries as manifests", () => {
    const input = {
      installed: [
        {
          pluginId: "documents@openai-primary-runtime",
          installed: true,
          enabled: true,
          name: "Documents",
          marketplaceName: "openai-primary-runtime",
          version: "1.0.0",
          extraMetadata: { retainedByCodex: true },
        },
      ],
      available: [
        {
          pluginId: "computer-use@openai-bundled",
          installed: false,
          enabled: false,
        },
      ],
    };
    expect(Either.isRight(decode(LiveOfficialPluginListEnvelopeSchema, input))).toBe(true);
    expect(parseLiveOfficialPluginList(input).ok).toBe(true);
    expect(parseOfficialPluginManifest(input.installed[0]).ok).toBe(false);
  });

  test("adds an exact plugin id and requires enabled readback", async () => {
    const recorded: string[][] = [];
    const runner = {
      run: async (args: readonly string[]) => {
        recorded.push([...args]);
        if (args[1] === "add") {
          return { exitCode: 0, stdout: "{}", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: "documents@openai-primary-runtime",
                installed: true,
                enabled: true,
              },
            ],
            available: [],
          }),
          stderr: "",
        };
      },
    };
    const adapter = createOfficialPluginAdapter({ executable: "codex", runner });
    await adapter.addMarketplace("davidbasilefilho/holycodex");
    await adapter.add("documents@openai-primary-runtime");
    expect(recorded[0]).toEqual(["plugin", "marketplace", "add", "davidbasilefilho/holycodex"]);
    expect(recorded[1]).toEqual(["plugin", "add", "documents@openai-primary-runtime", "--json"]);
    expect(recorded[2]).toEqual(["plugin", "list", "--json"]);
  });

  test("reports an installed-disabled provider as unavailable", async () => {
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) =>
          args[1] === "add"
            ? { exitCode: 0, stdout: "{}", stderr: "" }
            : {
                exitCode: 0,
                stdout: JSON.stringify({
                  installed: [
                    {
                      pluginId: "computer-use@openai-bundled",
                      installed: true,
                      enabled: false,
                    },
                  ],
                  available: [],
                }),
                stderr: "",
              },
      },
    });
    await expect(adapter.add("computer-use@openai-bundled")).rejects.toMatchObject({
      code: "plugin_disabled",
    } satisfies Partial<OfficialPluginAdapterError>);
  });
});

describe("Codex executable and diagnostics boundaries", () => {
  test("uses explicit allowlisted environment and deterministic PATH failure", async () => {
    const environment = createAllowlistedEnvironment({ PATH: "/bin", SECRET_TOKEN: "do-not-copy" });
    expect(environment["PATH"]).toBe("/bin");
    expect("SECRET_TOKEN" in environment).toBe(false);
    await expect(discoverCodexExecutable({ pathValue: "" })).rejects.toMatchObject({
      code: "discovery_failed",
    });
  });

  test("sanitizes bounded diagnostics", () => {
    expect(sanitizeDiagnostics("Bearer super-secret\ntoken=abc123\n\u0000ok")).toEqual([
      "Bearer [redacted]",
      "token=[redacted]",
      "ok",
    ]);
  });

  test("runs schema generation only through the explicit operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-schema-"));
    const outputDirectory = join(root, "generated");
    const executablePath = join(root, "codex");
    await mkdir(outputDirectory);
    await writeFile(executablePath, "codex test executable\n");
    const commands: string[][] = [];
    const bytes = await readFile(executablePath);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const digest = createSha256Digest(
      [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    if (!digest.ok) {
      throw digest.error;
    }
    const generated = await generateCodexSchemas({
      executable: { path: executablePath, version: "codex 1", sha256: digest.value },
      outputDirectory,
      commandRunner: async (_path, args) => {
        commands.push([...args]);
        await writeFile(join(outputDirectory, "types.ts"), "generated\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(generated.commands).toEqual(commands);
    expect(commands).toEqual([["app-server", "generate-ts", "--out", generated.outputDirectory]]);
    const emptyDirectory = join(root, "empty");
    await mkdir(emptyDirectory);
    await expect(
      generateCodexSchemas({
        executable: generated.executable,
        outputDirectory: emptyDirectory,
        commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toMatchObject({ code: "empty_output_directory" });
  });
});
