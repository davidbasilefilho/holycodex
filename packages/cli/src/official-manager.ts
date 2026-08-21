// SPDX-License-Identifier: Apache-2.0

import {
  createAllowlistedEnvironment,
  discoverCodexExecutable,
  parseOfficialPluginManifest,
  type OfficialPluginManifest,
  type OfficialPluginVerification,
} from "@holycodex/codex";
import type { OfficialPluginManager } from "./types.ts";

const OFFICIAL_COMMAND_TIMEOUT_MS = 30_000;

export interface OfficialPluginCommandRunner {
  readonly run: (
    args: readonly string[],
  ) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
}

export class CodexOfficialPluginManager implements OfficialPluginManager {
  private readonly runner: OfficialPluginCommandRunner;

  constructor(runner: OfficialPluginCommandRunner) {
    this.runner = runner;
  }

  static async discover(): Promise<CodexOfficialPluginManager> {
    const executable = await discoverCodexExecutable();
    return new CodexOfficialPluginManager({
      run: async (args) => runCodexCommand(executable.path, args),
    });
  }

  async list(): Promise<readonly OfficialPluginManifest[]> {
    return (await this.readList()).map((entry) => entry.manifest);
  }

  private async readList(): Promise<readonly PluginListEntry[]> {
    const result = await this.runner.run(["plugin", "list", "--json"]);
    if (result.exitCode !== 0) {
      throw new OfficialPluginManagerError("list_failed", "Codex could not list official plugins.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch (error: unknown) {
      throw new OfficialPluginManagerError(
        "list_failed",
        "Codex returned invalid plugin data.",
        error,
      );
    }
    let values: readonly unknown[];
    if (Array.isArray(parsed)) {
      values = parsed;
    } else if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "plugins" in parsed &&
      Array.isArray(parsed.plugins)
    ) {
      values = parsed.plugins;
    } else {
      throw new OfficialPluginManagerError(
        "list_failed",
        "Codex returned an invalid official plugin list.",
      );
    }
    const manifests: PluginListEntry[] = [];
    for (const value of values) {
      const verification = parseOfficialPluginManifest(value);
      if (!verification.ok) {
        throw new OfficialPluginManagerError(
          "list_failed",
          "Codex returned an invalid official plugin manifest.",
        );
      }
      manifests.push({ manifest: verification.value, state: listingState(value) });
    }
    return manifests;
  }

  async add(plugin: OfficialPluginVerification): Promise<void> {
    const result = await this.runner.run(["plugin", "add", plugin.manifest.name]);
    if (result.exitCode !== 0) {
      throw new OfficialPluginManagerError(
        "add_failed",
        "Codex could not add the selected official plugin.",
      );
    }
  }

  async status(
    selected: readonly string[],
  ): Promise<Readonly<Record<string, "installed" | "available" | "missing" | "unknown">>> {
    const entries = await this.readList();
    const byName = new Map(entries.map((entry) => [entry.manifest.name, entry.state]));
    return Object.fromEntries(selected.map((id) => [id, byName.get(id) ?? "missing"]));
  }
}

type PluginListState = "installed" | "available" | "unknown";
type PluginListEntry = Readonly<{
  readonly manifest: OfficialPluginManifest;
  readonly state: PluginListState;
}>;

function listingState(value: unknown): PluginListState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "installed";
  }
  if ("installed" in value && value.installed === true) {
    return "installed";
  }
  if ("available" in value && value.available === true) {
    return "available";
  }
  if ("status" in value && (value.status === "installed" || value.status === "available")) {
    return value.status;
  }
  return "installed";
}

async function runCodexCommand(
  executable: string,
  args: readonly string[],
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn([executable, ...args], {
    env: createAllowlistedEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    throw new OfficialPluginManagerError(
      "command_failed",
      "Codex plugin command output is unavailable.",
    );
  }
  try {
    const [stdout, stderr, exitCode] = await waitForChild(
      Promise.all([
        readBounded(child.stdout, 128 * 1024),
        readBounded(child.stderr, 16 * 1024),
        child.exited,
      ]),
      () => child.kill(),
    );
    return { exitCode, stdout, stderr };
  } catch (error: unknown) {
    try {
      child.kill();
    } catch {
      // The subprocess may already have exited.
    }
    if (error instanceof OfficialPluginManagerError) {
      throw error;
    }
    throw new OfficialPluginManagerError(
      "command_failed",
      "The Codex plugin command failed.",
      error,
    );
  }
}

async function waitForChild<T>(operation: Promise<T>, kill: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          try {
            kill();
          } catch {
            // The subprocess may already have exited.
          }
          reject(
            new OfficialPluginManagerError("command_failed", "The Codex plugin command timed out."),
          );
        }, OFFICIAL_COMMAND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        throw new OfficialPluginManagerError(
          "command_failed",
          "Codex plugin output exceeded the limit.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class OfficialPluginManagerError extends Error {
  readonly code: "list_failed" | "add_failed" | "command_failed";
  readonly causeValue: unknown;

  constructor(
    code: "list_failed" | "add_failed" | "command_failed",
    message: string,
    causeValue?: unknown,
  ) {
    super(message);
    this.name = "OfficialPluginManagerError";
    this.code = code;
    this.causeValue = causeValue;
  }
}
