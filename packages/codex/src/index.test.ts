// SPDX-License-Identifier: Apache-2.0

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSha256Digest, decodeUnknown } from "@holycodex/core";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vite-plus/test";

import {
  AppServerClient,
  bootstrapOfficialMarketplace,
  CODEX_PROTOCOL_VERSION,
  ConfigReadParamsSchema,
  ConfigReadResultSchema,
  createOfficialPluginAdapter,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
  LiveOfficialPluginListEnvelopeSchema,
  OfficialPluginAdapterError,
  OFFICIAL_CURATED_MARKETPLACE_NAME,
  OFFICIAL_CURATED_MARKETPLACE_SOURCE,
  OfficialPluginManifestSchema,
  parseOfficialMarketplaceSnapshot,
  provisionOfficialMarketplaceSnapshot,
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
  userAgent: `codex-cli ${CODEX_PROTOCOL_VERSION.slice("codex-cli-".length)}`,
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "linux",
  serverInfo: { name: "codex", version: CODEX_PROTOCOL_VERSION.slice("codex-cli-".length) },
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
  test("validates current config readback and its TOML layer options", () => {
    expect(
      Either.isRight(
        decode(ConfigReadParamsSchema, {
          includeLayers: true,
          cwd: "/workspace/project",
        }),
      ),
    ).toBe(true);
    expect(
      Either.isRight(
        decode(ConfigReadResultSchema, {
          config: {
            model: "gpt-5.6-terra",
            features: { default_mode_request_user_input: true },
          },
          origins: {},
          layers: null,
        }),
      ),
    ).toBe(true);
  });

  test("preserves unrelated keys and later user edits during managed cleanup", async () => {
    const metadata = { owner: "holycodex" as const, schema: "0.15", installId: "install-1" };
    const initial = createManagedConfigState(metadata);
    const merged = await mergeManagedConfig(
      { unrelated: "keep", model: "gpt-5.6-luna" },
      initial,
      { model: "gpt-5.6-terra", "features.default_mode_request_user_input": true },
      metadata,
    );
    const userEdited = { ...merged.document, model: "gpt-5.6-sol" };
    const cleaned = await cleanupManagedConfig(userEdited, merged.state, metadata);
    expect(cleaned.document).toEqual({
      unrelated: "keep",
      model: "gpt-5.6-sol",
    });
    expect(cleaned.preservedKeys).toEqual(["model"]);
    const restored = await cleanupManagedConfig(merged.document, merged.state, metadata);
    expect(restored.document).toEqual({ unrelated: "keep", model: "gpt-5.6-luna" });
    expect(restored.restoredKeys).toEqual(["model", "features.default_mode_request_user_input"]);
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

  test("validates the reserved official marketplace snapshot and source paths", () => {
    const snapshot = parseOfficialMarketplaceSnapshot({
      name: OFFICIAL_CURATED_MARKETPLACE_NAME,
      source: OFFICIAL_CURATED_MARKETPLACE_SOURCE,
      plugins: [
        { name: "build-web-apps", source: "./plugins/build-web-apps" },
        { name: "codex-security", source: "./plugins/codex-security" },
      ],
    });
    expect(snapshot.plugins.map((plugin) => plugin.name)).toEqual([
      "build-web-apps",
      "codex-security",
    ]);
    expect(() =>
      parseOfficialMarketplaceSnapshot({
        name: OFFICIAL_CURATED_MARKETPLACE_NAME,
        source: "https://example.invalid/plugins.git",
        plugins: [{ name: "build-web-apps", source: "./plugins/build-web-apps" }],
      }),
    ).toThrow("approved OpenAI repository");
    expect(() =>
      parseOfficialMarketplaceSnapshot({
        name: OFFICIAL_CURATED_MARKETPLACE_NAME,
        plugins: [{ name: "build-web-apps", source: "https://example.invalid/plugin" }],
      }),
    ).toThrow("source for build-web-apps is unsafe");
  });

  test("waits for a delayed official marketplace sync", async () => {
    const snapshot = parseOfficialMarketplaceSnapshot({
      name: OFFICIAL_CURATED_MARKETPLACE_NAME,
      source: OFFICIAL_CURATED_MARKETPLACE_SOURCE,
      plugins: [
        { name: "build-web-apps", source: "./plugins/build-web-apps" },
        { name: "codex-security", source: "./plugins/codex-security" },
      ],
    });
    let reads = 0;
    let initialized = 0;
    let closed = 0;
    const result = await bootstrapOfficialMarketplace({
      codexHome: "/tmp/codex-bootstrap-test",
      executablePath: "/tmp/codex",
      selectedPluginIds: ["build-web-apps@openai-curated", "codex-security@openai-curated"],
      timeoutMs: 100,
      pollIntervalMs: 0,
      initializeRuntime: async () => {
        initialized += 1;
        return async () => {
          closed += 1;
        };
      },
      readSnapshot: async () => {
        reads += 1;
        return reads < 3 ? undefined : snapshot;
      },
      sleep: async () => undefined,
    });
    expect(result).toBe(snapshot);
    expect(initialized).toBe(1);
    expect(closed).toBe(1);
    expect(reads).toBe(3);
  });

  test("fails closed on an official marketplace timeout", async () => {
    let initialized = 0;
    await expect(
      bootstrapOfficialMarketplace({
        codexHome: "/tmp/codex-bootstrap-timeout",
        executablePath: "/tmp/codex",
        selectedPluginIds: ["build-web-apps@openai-curated"],
        timeoutMs: 1,
        pollIntervalMs: 0,
        initializeRuntime: async () => {
          initialized += 1;
          return async () => undefined;
        },
        readSnapshot: async () => undefined,
        sleep: async () => undefined,
        gitFallback: false,
      }),
    ).rejects.toMatchObject({ code: "marketplace_timeout" });
    expect(initialized).toBe(1);
  });

  test("rejects a symlinked marketplace ancestor before App Server startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-official-marketplace-ancestor-"));
    const codexHome = join(root, "codex");
    const outside = join(root, "outside");
    let initialized = false;
    try {
      await mkdir(codexHome, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(codexHome, "plugins"));
      await expect(
        bootstrapOfficialMarketplace({
          codexHome,
          executablePath: "/tmp/codex",
          selectedPluginIds: ["build-web-apps@openai-curated"],
          initializeRuntime: async () => {
            initialized = true;
            return async () => undefined;
          },
        }),
      ).rejects.toMatchObject({ code: "marketplace_invalid" });
      expect(initialized).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("verifies and atomically publishes a shallow official Git snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-official-marketplace-"));
    const codexHome = join(root, "codex");
    const head = "a".repeat(40);
    const commands: string[][] = [];
    const runner = {
      run: async (args: readonly string[]) => {
        commands.push([...args]);
        if (args[0] === "ls-remote") {
          return { exitCode: 0, stdout: `${head}\tHEAD\n`, stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
      },
    };
    try {
      const snapshot = await provisionOfficialMarketplaceSnapshot({
        codexHome,
        selectedPluginIds: ["build-web-apps@openai-curated", "codex-security@openai-curated"],
        gitRunner: runner,
        cloneSnapshot: async (source, destination) => {
          expect(source).toBe(OFFICIAL_CURATED_MARKETPLACE_SOURCE);
          await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
          await writeFile(
            join(destination, ".agents", "plugins", "marketplace.json"),
            JSON.stringify({
              name: OFFICIAL_CURATED_MARKETPLACE_NAME,
              plugins: [
                { name: "build-web-apps", source: "./build-web-apps" },
                { name: "codex-security", source: "./codex-security" },
              ],
            }),
          );
        },
      });
      expect(snapshot.rootPath).toBe(await realpath(join(codexHome, "plugins", "openai-plugins")));
      expect(commands).toEqual([
        ["ls-remote", OFFICIAL_CURATED_MARKETPLACE_SOURCE, "HEAD"],
        ["rev-parse", "HEAD"],
      ]);
      await expect(
        readFile(
          join(codexHome, "plugins", "openai-plugins", ".agents", "plugins", "marketplace.json"),
          "utf8",
        ),
      ).resolves.toContain(OFFICIAL_CURATED_MARKETPLACE_NAME);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a remote HEAD mismatch and cleans staged content", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-official-marketplace-mismatch-"));
    const codexHome = join(root, "codex");
    const remoteHead = "b".repeat(40);
    try {
      await expect(
        provisionOfficialMarketplaceSnapshot({
          codexHome,
          selectedPluginIds: ["build-web-apps@openai-curated"],
          gitRunner: {
            run: async (args) =>
              args[0] === "ls-remote"
                ? { exitCode: 0, stdout: `${remoteHead}\tHEAD\n`, stderr: "" }
                : { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" },
          },
          cloneSnapshot: async (_source, destination) => {
            await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
            await writeFile(
              join(destination, ".agents", "plugins", "marketplace.json"),
              JSON.stringify({
                name: OFFICIAL_CURATED_MARKETPLACE_NAME,
                plugins: [{ name: "build-web-apps", source: "./build-web-apps" }],
              }),
            );
          },
        }),
      ).rejects.toMatchObject({ code: "marketplace_invalid" });
      const parent = join(codexHome, "plugins");
      const entries = await readdir(parent);
      expect(entries.some((entry) => entry.startsWith(".openai-plugins-stage-"))).toBe(false);
      await expect(readFile(join(parent, "openai-plugins", "marketplace.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports an offline Git fallback and removes failed staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-official-marketplace-offline-"));
    const codexHome = join(root, "codex");
    try {
      await expect(
        provisionOfficialMarketplaceSnapshot({
          codexHome,
          selectedPluginIds: ["build-web-apps@openai-curated"],
          gitRunner: {
            run: async (args) =>
              args[0] === "ls-remote"
                ? { exitCode: 0, stdout: `${"1".repeat(40)}\tHEAD\n`, stderr: "" }
                : { exitCode: 1, stdout: "", stderr: "network is unreachable" },
          },
        }),
      ).rejects.toMatchObject({ code: "marketplace_unavailable" });
      const parent = join(codexHome, "plugins");
      const entries = await readdir(parent);
      expect(entries.some((entry) => entry.startsWith(".openai-plugins-stage-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for malformed or symlinked official snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-official-marketplace-unsafe-"));
    const codexHome = join(root, "codex");
    try {
      await expect(
        provisionOfficialMarketplaceSnapshot({
          codexHome,
          selectedPluginIds: ["build-web-apps@openai-curated"],
          gitRunner: {
            run: async (args) =>
              args[0] === "ls-remote"
                ? { exitCode: 0, stdout: `${"d".repeat(40)}\tHEAD\n`, stderr: "" }
                : { exitCode: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" },
          },
          cloneSnapshot: async (_source, destination) => {
            await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
            await symlink("/tmp", join(destination, "unsafe-link"));
            await writeFile(
              join(destination, ".agents", "plugins", "marketplace.json"),
              JSON.stringify({
                name: OFFICIAL_CURATED_MARKETPLACE_NAME,
                plugins: [{ name: "build-web-apps", source: "./build-web-apps" }],
              }),
            );
          },
        }),
      ).rejects.toMatchObject({ code: "marketplace_invalid" });
      await expect(
        provisionOfficialMarketplaceSnapshot({
          codexHome,
          selectedPluginIds: ["build-web-apps@openai-curated"],
          gitRunner: {
            run: async (args) =>
              args[0] === "ls-remote"
                ? { exitCode: 0, stdout: `${"e".repeat(40)}\tHEAD\n`, stderr: "" }
                : { exitCode: 0, stdout: `${"e".repeat(40)}\n`, stderr: "" },
          },
          cloneSnapshot: async (_source, destination) => {
            await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
            await writeFile(
              join(destination, ".agents", "plugins", "marketplace.json"),
              JSON.stringify({
                name: OFFICIAL_CURATED_MARKETPLACE_NAME,
                plugins: [{ name: "build-web-apps", source: "../other" }],
              }),
            );
          },
        }),
      ).rejects.toMatchObject({ code: "marketplace_invalid" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a publication collision without replacing the existing path", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-official-marketplace-collision-"));
    const codexHome = join(root, "codex");
    try {
      await expect(
        provisionOfficialMarketplaceSnapshot({
          codexHome,
          selectedPluginIds: ["build-web-apps@openai-curated"],
          gitRunner: {
            run: async (args) =>
              args[0] === "ls-remote"
                ? { exitCode: 0, stdout: `${"f".repeat(40)}\tHEAD\n`, stderr: "" }
                : { exitCode: 0, stdout: `${"f".repeat(40)}\n`, stderr: "" },
          },
          cloneSnapshot: async (_source, destination) => {
            await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
            await writeFile(
              join(destination, ".agents", "plugins", "marketplace.json"),
              JSON.stringify({
                name: OFFICIAL_CURATED_MARKETPLACE_NAME,
                plugins: [{ name: "build-web-apps", source: "./build-web-apps" }],
              }),
            );
            await mkdir(join(codexHome, "plugins", "openai-plugins"), { recursive: true });
            await writeFile(join(codexHome, "plugins", "openai-plugins", "keep.txt"), "preserve");
          },
        }),
      ).rejects.toMatchObject({ code: "marketplace_invalid" });
      await expect(
        readFile(join(codexHome, "plugins", "openai-plugins", "keep.txt"), "utf8"),
      ).resolves.toBe("preserve");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not initialize Codex when the official marketplace is already present", async () => {
    const snapshot = parseOfficialMarketplaceSnapshot({
      name: OFFICIAL_CURATED_MARKETPLACE_NAME,
      source: OFFICIAL_CURATED_MARKETPLACE_SOURCE,
      plugins: [{ name: "build-web-apps", source: "./plugins/build-web-apps" }],
    });
    let initialized = false;
    await expect(
      bootstrapOfficialMarketplace({
        codexHome: "/tmp/codex-bootstrap-present",
        executablePath: "/tmp/codex",
        selectedPluginIds: ["build-web-apps@openai-curated"],
        initializeRuntime: async () => {
          initialized = true;
          return async () => undefined;
        },
        readSnapshot: async () => snapshot,
      }),
    ).resolves.toBe(snapshot);
    expect(initialized).toBe(false);
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

  test("redacts credentials from plugin command failures", async () => {
    const sentinel = "super-secret-token-value";
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async () => ({ exitCode: 1, stdout: "", stderr: `token=${sentinel}` }),
      },
    });
    await expect(adapter.list()).rejects.toMatchObject({
      code: "command_failed",
      message: expect.not.stringContaining(sentinel),
    });
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
