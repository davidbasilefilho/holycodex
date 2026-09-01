// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { spawn } from "node:child_process";
import {
  checked,
  CodexError,
  failure,
  invalidData,
  isPlainObject,
  isValid,
  JsonValueSchema,
  success,
  TextSchema,
  type CodexResult,
} from "./common";
import { allowlistedEnvironment } from "./transport";

const PluginNameSchema = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9._-]{1,63}$/u));
const PluginVersionSchema = Schema.String.pipe(
  Schema.pattern(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u),
);
const StringArraySchema = Schema.Array(Schema.String);

export const OfficialPluginIdSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u),
);
export type OfficialPluginId = typeof OfficialPluginIdSchema.Type;

export const OfficialPluginManifestSchema = Schema.Struct({
  name: PluginNameSchema,
  version: PluginVersionSchema,
  description: TextSchema,
  author: Schema.optional(JsonValueSchema),
  license: Schema.optional(TextSchema),
  homepage: Schema.optional(TextSchema),
  repository: Schema.optional(TextSchema),
  keywords: Schema.optional(StringArraySchema),
  skills: Schema.optional(StringArraySchema),
  commands: Schema.optional(StringArraySchema),
  hooks: Schema.optional(StringArraySchema),
  assets: Schema.optional(StringArraySchema),
  official: Schema.optional(Schema.Boolean),
});
export type OfficialPluginManifest = typeof OfficialPluginManifestSchema.Type;

export interface OfficialPluginVerification {
  readonly manifest: OfficialPluginManifest;
  readonly manifestPath?: string;
  readonly explicitlySelected: boolean;
}

function containsMcpDeclaration(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsMcpDeclaration(item));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/mcp|model[._-]?context[._-]?protocol/iu.test(key)) {
      return true;
    }
    if (containsMcpDeclaration(item)) {
      return true;
    }
  }
  return false;
}

export function parseOfficialPluginManifest(input: unknown): CodexResult<OfficialPluginManifest> {
  if (containsMcpDeclaration(input)) {
    return failure(
      new CodexError("manifest_invalid", "HolyCodex-owned plugin payloads cannot declare MCP."),
    );
  }
  if (!isValid(OfficialPluginManifestSchema, input)) {
    return failure(invalidData("official plugin manifest", input));
  }
  return success(checked(OfficialPluginManifestSchema, input, "official plugin manifest"));
}

export function verifyOfficialPluginManifest(input: unknown): OfficialPluginVerification {
  const parsed = parseOfficialPluginManifest(input);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return { manifest: parsed.value, explicitlySelected: false };
}

export async function verifyOfficialPluginManifestFile(
  pluginRoot: string,
): Promise<OfficialPluginVerification> {
  let root: string;
  try {
    root = await realpath(pluginRoot);
    if (!(await stat(root)).isDirectory()) {
      throw new Error("plugin root is not a directory");
    }
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The official plugin root is invalid.",
      {},
      { cause: error },
    );
  }
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  let contents: string;
  try {
    const manifestEntry = await lstat(manifestPath);
    if (manifestEntry.isSymbolicLink() || !manifestEntry.isFile()) {
      throw new Error("plugin manifest is not a regular file");
    }
    contents = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(manifestPath));
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The plugin is missing .codex-plugin/plugin.json.",
      {},
      { cause: error },
    );
  }
  let parsedJson: unknown;
  try {
    // JSON.parse is immediately validated by the manifest schema and MCP-key scan.
    parsedJson = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The plugin manifest is not valid JSON.",
      {},
      { cause: error },
    );
  }
  const verification = verifyOfficialPluginManifest(parsedJson);
  return { ...verification, manifestPath };
}

export const OfficialPluginSelectionSchema = Schema.Struct({
  id: PluginNameSchema,
  selected: Schema.Literal(true),
});
export type OfficialPluginSelection = typeof OfficialPluginSelectionSchema.Type;

export function selectOfficialPlugins(
  available: readonly OfficialPluginManifest[],
  selections: readonly OfficialPluginSelection[],
): readonly OfficialPluginVerification[] {
  const byName = new Map(available.map((manifest) => [manifest.name, manifest]));
  const output: OfficialPluginVerification[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const parsedSelection = checked(
      OfficialPluginSelectionSchema,
      selection,
      "official plugin selection",
    );
    if (seen.has(parsedSelection.id)) {
      throw new CodexError("manifest_invalid", "An official plugin was selected more than once.", {
        id: parsedSelection.id,
      });
    }
    const manifest = byName.get(parsedSelection.id);
    if (!manifest) {
      throw new CodexError(
        "manifest_invalid",
        "An explicitly selected official plugin is unavailable.",
        {
          id: parsedSelection.id,
        },
      );
    }
    seen.add(parsedSelection.id);
    output.push({ manifest, explicitlySelected: true });
  }
  return output;
}

export const LiveOfficialPluginEntrySchema = Schema.Struct(
  {
    pluginId: OfficialPluginIdSchema,
    installed: Schema.Boolean,
    enabled: Schema.Boolean,
    name: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
    marketplaceName: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
    version: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);
export type LiveOfficialPluginEntry = typeof LiveOfficialPluginEntrySchema.Type;

export const LiveOfficialPluginListEnvelopeSchema = Schema.Struct({
  installed: Schema.Array(LiveOfficialPluginEntrySchema),
  available: Schema.Array(LiveOfficialPluginEntrySchema),
});
export type LiveOfficialPluginListEnvelope = typeof LiveOfficialPluginListEnvelopeSchema.Type;

export function parseLiveOfficialPluginList(
  input: unknown,
): CodexResult<LiveOfficialPluginListEnvelope> {
  if (!isValid(LiveOfficialPluginListEnvelopeSchema, input)) {
    return failure(invalidData("live official plugin list", input));
  }
  return success(checked(LiveOfficialPluginListEnvelopeSchema, input, "live official plugin list"));
}

export interface OfficialPluginCommandRunner {
  readonly run: (
    args: readonly string[],
    options?: Readonly<{ readonly signal?: AbortSignal; readonly timeoutMs?: number }>,
  ) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
}

export interface OfficialPluginAdapterOptions {
  readonly executable: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly runner?: OfficialPluginCommandRunner;
  readonly timeoutMs?: number;
  readonly stdoutLimit?: number;
  readonly stderrLimit?: number;
}

export interface OfficialPluginAdapter {
  readonly list: () => Promise<LiveOfficialPluginListEnvelope>;
  readonly addMarketplace: (source: string, signal?: AbortSignal) => Promise<void>;
  readonly add: (pluginId: string, signal?: AbortSignal) => Promise<void>;
  readonly enableFeature: (feature: string, signal?: AbortSignal) => Promise<void>;
  readonly featureEnabled: (feature: string) => Promise<boolean>;
}

export class OfficialPluginAdapterError extends Error {
  readonly code:
    | "command_failed"
    | "timeout"
    | "output_limit"
    | "cancelled"
    | "readback_mismatch"
    | "plugin_disabled"
    | "plugin_missing";
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: OfficialPluginAdapterError["code"],
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "OfficialPluginAdapterError";
    this.code = code;
    this.details = details;
  }
}

export function createOfficialPluginAdapter(
  options: OfficialPluginAdapterOptions,
): OfficialPluginAdapter {
  const runner =
    options.runner ??
    createNodeBunOfficialPluginCommandRunner(options.executable, {
      environment: options.environment ?? allowlistedEnvironment(),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.stdoutLimit === undefined ? {} : { stdoutLimit: options.stdoutLimit }),
      ...(options.stderrLimit === undefined ? {} : { stderrLimit: options.stderrLimit }),
    });
  const list = async (): Promise<LiveOfficialPluginListEnvelope> => {
    const result = await runner.run(["plugin", "list", "--json"]);
    if (result.exitCode !== 0) {
      throw commandError("list", result);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new OfficialPluginAdapterError("command_failed", "Codex returned invalid plugin data.");
    }
    const decoded = parseLiveOfficialPluginList(parsed);
    if (!decoded.ok) {
      throw new OfficialPluginAdapterError(
        "command_failed",
        "Codex returned an invalid official plugin list.",
      );
    }
    return decoded.value;
  };
  return {
    list,
    enableFeature: async (feature, signal) => {
      const checkedFeature = checked(PluginNameSchema, feature, "Codex feature name");
      const result = await runner.run(
        ["features", "enable", checkedFeature],
        signal === undefined ? undefined : { signal },
      );
      if (result.exitCode !== 0) throw commandError("feature enable", result, checkedFeature);
    },
    featureEnabled: async (feature) => {
      const checkedFeature = checked(PluginNameSchema, feature, "Codex feature name");
      const result = await runner.run(["features", "list"]);
      if (result.exitCode !== 0) throw commandError("feature list", result, checkedFeature);
      const line = result.stdout
        .split(/\r?\n/u)
        .find((candidate) => candidate.trimStart().startsWith(`${checkedFeature} `));
      if (line === undefined) return false;
      return /\btrue\s*$/u.test(line);
    },
    addMarketplace: async (source, signal) => {
      const checkedSource = checked(OfficialPluginIdSchema, source, "plugin marketplace source");
      const result = await runner.run(
        ["plugin", "marketplace", "add", checkedSource],
        signal === undefined ? undefined : { signal },
      );
      if (result.exitCode !== 0 && !/already (?:exists|added)/iu.test(result.stderr)) {
        throw commandError("marketplace add", result, checkedSource);
      }
    },
    add: async (pluginId, signal) => {
      const checkedPluginId = checked(OfficialPluginIdSchema, pluginId, "official plugin id");
      const result = await runner.run(
        ["plugin", "add", checkedPluginId, "--json"],
        signal === undefined ? undefined : { signal },
      );
      if (result.exitCode !== 0) {
        throw commandError("add", result, checkedPluginId);
      }
      const live = await list();
      const entries = [...live.installed, ...live.available].filter(
        (entry) => entry.pluginId === checkedPluginId,
      );
      const entry = entries.find((candidate) => candidate.installed) ?? entries[0];
      if (!entry) {
        throw new OfficialPluginAdapterError(
          "readback_mismatch",
          `Codex did not report ${checkedPluginId} after installation.`,
          { plugin_id: checkedPluginId },
        );
      }
      if (!entry.installed) {
        throw new OfficialPluginAdapterError(
          "plugin_missing",
          `Codex reported ${checkedPluginId} as unavailable after installation.`,
          { plugin_id: checkedPluginId },
        );
      }
      if (!entry.enabled) {
        throw new OfficialPluginAdapterError(
          "plugin_disabled",
          `Codex installed ${checkedPluginId} but it is disabled; enable it in Codex and retry.`,
          { plugin_id: checkedPluginId },
        );
      }
    },
  };
}

function commandError(
  operation: "list" | "add" | "marketplace add" | "feature enable" | "feature list",
  result: Readonly<{ exitCode: number; stdout: string; stderr: string }>,
  pluginId?: string,
): OfficialPluginAdapterError {
  const diagnostics = Array.from(result.stderr)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 512);
  const suffix = diagnostics.length > 0 ? `: ${diagnostics}` : "";
  return new OfficialPluginAdapterError(
    "command_failed",
    `Codex plugin ${operation} failed${pluginId === undefined ? "" : ` for ${pluginId}`}${suffix}`,
    { exit_code: result.exitCode },
  );
}

function createNodeBunOfficialPluginCommandRunner(
  executable: string,
  options: Readonly<{
    readonly environment?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly stdoutLimit?: number;
    readonly stderrLimit?: number;
  }>,
): OfficialPluginCommandRunner {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stdoutLimit = options.stdoutLimit ?? 128 * 1024;
  const stderrLimit = options.stderrLimit ?? 16 * 1024;
  return {
    run: (args, runOptions) =>
      runNodeBunCommand(executable, args, {
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        timeoutMs: runOptions?.timeoutMs ?? timeoutMs,
        stdoutLimit,
        stderrLimit,
        ...(runOptions?.signal === undefined ? {} : { signal: runOptions.signal }),
      }),
  };
}

async function runNodeBunCommand(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    readonly environment?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly stdoutLimit: number;
    readonly stderrLimit: number;
    readonly signal?: AbortSignal;
  }>,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  if (options.signal?.aborted) {
    throw new OfficialPluginAdapterError("cancelled", "The Codex plugin command was cancelled.");
  }
  const child = spawn(executable, [...args], {
    env: options.environment === undefined ? undefined : { ...options.environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = collectChildStream(child.stdout, options.stdoutLimit);
  const stderr = collectChildStream(child.stderr, options.stderrLimit);
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    abortHandler = () => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      reject(
        new OfficialPluginAdapterError("cancelled", "The Codex plugin command was cancelled."),
      );
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      reject(new OfficialPluginAdapterError("timeout", "The Codex plugin command timed out."));
    }, options.timeoutMs);
  });
  try {
    const [stdoutText, stderrText, exitCode] = await Promise.race([
      Promise.all([stdout, stderr, exit]),
      cancellation,
      timeout,
    ]);
    return { stdout: stdoutText, stderr: stderrText, exitCode };
  } catch (error: unknown) {
    try {
      child.kill();
    } catch {
      // The process may already be gone.
    }
    if (error instanceof OfficialPluginAdapterError) throw error;
    throw new OfficialPluginAdapterError("command_failed", "The Codex plugin command failed.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler !== undefined) options.signal?.removeEventListener("abort", abortHandler);
  }
}

function collectChildStream(stream: NodeJS.ReadableStream | null, limit: number): Promise<string> {
  if (stream === null) {
    return Promise.reject(
      new OfficialPluginAdapterError(
        "command_failed",
        "Codex plugin command output is unavailable.",
      ),
    );
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    stream.on("data", (chunk: unknown) => {
      const bytes =
        typeof chunk === "string"
          ? new TextEncoder().encode(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : undefined;
      if (bytes === undefined) {
        reject(
          new OfficialPluginAdapterError("command_failed", "Codex plugin output was invalid."),
        );
        return;
      }
      size += bytes.byteLength;
      if (size > limit) {
        reject(
          new OfficialPluginAdapterError("output_limit", "Codex plugin output exceeded its limit."),
        );
        return;
      }
      chunks.push(bytes);
    });
    stream.once("end", () => {
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(output));
      } catch (error: unknown) {
        reject(error);
      }
    });
    stream.once("error", (error: unknown) => reject(error));
  });
}
