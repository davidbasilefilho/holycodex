// SPDX-License-Identifier: Apache-2.0

import { describe, expect, mock, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTomlPath } from "@holycodex/codex";
import type { TomlDocument, TomlValue } from "@holycodex/codex";

import {
  doctorHolyCodex,
  installRecordDigest,
  installHolyCodex,
  InstallerError,
  readActiveInstallRecord,
  removeHolyCodex,
  resolveInstallerPaths,
  runCli,
  upgradeHolyCodex,
  validateInstallOptions,
} from "./index.ts";
import type {
  InstallRequest,
  InstallRecord,
  InstallerRuntime,
  ManagedConflict,
  OfficialPluginManager,
} from "./index.ts";
import {
  assertInstallTransactionState,
  assertRemovalTransactionState,
  diagnoseInstallTransactions,
  parseConfig,
  serializeConfig,
} from "./installer.ts";
import type { InstallReview } from "./types.ts";

const realFs = await import("node:fs/promises");
const realRm = realFs.rm;

const toolingStates = new Map<string, { installed: boolean }>();

function testRuntime(codexHome: string): InstallerRuntime {
  const state = toolingStates.get(codexHome) ?? { installed: false };
  toolingStates.set(codexHome, state);
  const binRoot = "/fake/preflight/bin";
  const projectRoot = "/fake/preflight/install/global";
  const packageRoot = "/fake/preflight/install/global/node_modules/ctx7";
  const packageExecutable = `${packageRoot}/dist/index.js`;
  const shim = `${binRoot}/ctx7`;
  return {
    platform: "linux",
    environment: { PATH: binRoot },
    processPath: "bun",
    files: {
      access: async (path) => {
        const normalizedPath = path.replaceAll("\\", "/");
        if (
          ![binRoot, projectRoot].includes(normalizedPath) &&
          (!state.installed || ![packageRoot, packageExecutable, shim].includes(normalizedPath))
        ) {
          throw new Error("missing");
        }
      },
      readText: async (path) => {
        if (!state.installed || path.replaceAll("\\", "/") !== `${packageRoot}/package.json`) {
          throw new Error("missing");
        }
        return JSON.stringify({ version: "2.0.0", bin: { ctx7: "dist/index.js" } });
      },
      realpath: async (path) => path,
    },
    run: async (executable, args) => {
      const command = `${executable} ${args.join(" ")}`;
      const normalizedCommand = command.replaceAll("\\", "/");
      if (command === "bun pm bin -g") return { exitCode: 0, stdout: `${binRoot}\n`, stderr: "" };
      if (command === "bun pm view ctx7 version")
        return { exitCode: 0, stdout: "2.0.0\n", stderr: "" };
      if (command === "bun add -g ctx7@latest") {
        state.installed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "bun remove -g ctx7") {
        state.installed = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (normalizedCommand === `${shim} --version` && state.installed) {
        return { exitCode: 0, stdout: "ctx7 2.0.0\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "missing" };
    },
  };
}

function testManager(events: string[] = []): OfficialPluginManager {
  const states = new Map<string, { installed: boolean; enabled: boolean }>();
  const manager: OfficialPluginManager = {
    list: async () => ({
      installed: [...states]
        .filter(([, state]) => state.installed)
        .map(([pluginId, state]) => ({ pluginId, ...state })),
      available: [...states]
        .filter(([, state]) => !state.installed)
        .map(([pluginId, state]) => ({ pluginId, ...state })),
    }),
    addMarketplace: async (source) => {
      events.push(`marketplace:${source}`);
    },
    add: async (pluginId) => {
      events.push(`add:${pluginId}`);
      states.set(pluginId, { installed: true, enabled: true });
    },
    remove: async (pluginId) => {
      events.push(`remove:${pluginId}`);
      states.delete(pluginId);
    },
  };
  return manager;
}

type TestPaths = ReturnType<typeof resolveInstallerPaths>;

async function managedRolePath(codexHome: string, name: string): Promise<string> {
  const paths = resolveInstallerPaths({ paths: { codexHome } });
  const record = await readActiveInstallRecord(paths);
  const artifact = record?.managed_artifacts.find((entry) => entry.path.endsWith(`/${name}.toml`));
  if (artifact === undefined) throw new Error(`Missing managed role artifact: ${name}`);
  return join(codexHome, artifact.path);
}

function readTestTomlTable(value: TomlValue | undefined): TomlDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as TomlDocument;
}

function readTestConfigEntry(
  document: TomlDocument,
  parent: "plugins" | "marketplaces",
  key: string,
): TomlValue | undefined {
  return readTestTomlTable(document[parent])[key];
}

async function writeTestConfigValue(
  paths: TestPaths,
  keyPath: string,
  value: TomlValue,
): Promise<void> {
  const current = await readFile(paths.configFile, "utf8").catch(() => undefined);
  const quotedPluginKey = /^plugins\."(.*)"$/u.exec(keyPath)?.[1];
  const document = parseConfig(current);
  const pluginTable = readTestTomlTable(document["plugins"]);
  const next =
    quotedPluginKey === undefined
      ? writeTomlPath(document, keyPath, value)
      : writeTomlPath(document, "plugins", {
          ...pluginTable,
          [quotedPluginKey]: value,
        });
  await writeFile(paths.configFile, serializeConfig(next));
}

function configWritingManager(
  paths: TestPaths,
  events: string[] = [],
  failHolyCodexOnce = false,
  failPluginId?: string,
  beforeAdd?: (pluginId: string) => Promise<void>,
): OfficialPluginManager {
  const states = new Map<string, { installed: boolean; enabled: boolean }>();
  let failNextHolyCodexAdd = failHolyCodexOnce;
  let failNextPluginAdd = failPluginId;
  return {
    list: async () => ({
      installed: [...states]
        .filter(([, state]) => state.installed)
        .map(([pluginId, state]) => ({ pluginId, ...state })),
      available: [...states]
        .filter(([, state]) => !state.installed)
        .map(([pluginId, state]) => ({ pluginId, ...state })),
    }),
    addMarketplace: async (source) => {
      events.push(`marketplace:${source}`);
      await writeTestConfigValue(paths, "marketplaces.holycodex", {
        source_type: "git",
        source:
          source === "davidbasilefilho/holycodex"
            ? "https://github.com/davidbasilefilho/holycodex.git"
            : source,
      });
    },
    add: async (pluginId) => {
      events.push(`add:${pluginId}`);
      await beforeAdd?.(pluginId);
      states.set(pluginId, { installed: true, enabled: true });
      await writeTestConfigValue(paths, `plugins."${pluginId}"`, { enabled: true });
      if (pluginId === "holycodex@holycodex" && failNextHolyCodexAdd) {
        failNextHolyCodexAdd = false;
        throw new Error("plugin install failed");
      }
      if (pluginId === failNextPluginAdd) {
        failNextPluginAdd = undefined;
        throw new Error("plugin install failed");
      }
    },
    remove: async (pluginId) => {
      events.push(`remove:${pluginId}`);
      states.delete(pluginId);
    },
  };
}

const request: InstallRequest = {
  optional: {},
};

async function installBaseline(codexHome: string, events: string[] = []) {
  const manager = testManager(events);
  const runtime = testRuntime(codexHome);
  const result = await installHolyCodex(request, {
    paths: { codexHome },
    officialPluginManager: manager,
    runtime,
  });
  return { manager, result, runtime };
}

function withBrowserListed(manager: OfficialPluginManager): OfficialPluginManager {
  const list = manager.list;
  if (list === undefined) throw new Error("The test plugin manager must implement list().");
  return {
    ...manager,
    list: async () => {
      const live = await list();
      return {
        ...live,
        installed: [
          ...live.installed,
          { pluginId: "browser@openai-bundled", installed: true, enabled: true },
        ],
      };
    },
  };
}

function fakeConflictResolverModule(
  keys: readonly { readonly name: string; readonly ctrl?: boolean }[],
): Record<string, unknown> {
  class FakeStyledText {
    constructor(readonly chunks: readonly { readonly text: string }[]) {}
  }
  class FakeTextRenderable {
    content: unknown;

    constructor(_renderer: unknown, options: { readonly content: unknown }) {
      this.content = options.content;
    }
  }

  let keypress: ((key: { readonly name: string; readonly ctrl?: boolean }) => void) | undefined;
  const renderer = {
    root: { add: (_value: unknown): void => undefined },
    keyInput: {
      on: (_event: string, listener: typeof keypress): void => {
        keypress = listener;
      },
      off: (): void => {
        keypress = undefined;
      },
    },
    requestRender: (): void => undefined,
    start: (): void => {
      for (const key of keys) keypress?.(key);
    },
    destroy: (): void => undefined,
  };
  const identityStyle =
    () =>
    (value: unknown): unknown =>
      value;
  return {
    createCliRenderer: async () => renderer,
    TextRenderable: FakeTextRenderable,
    StyledText: FakeStyledText,
    stringToStyledText: (text: string) => new FakeStyledText([{ text }]),
    fg: identityStyle,
    bold: identityStyle,
  };
}

async function writeLegacyBrowserOwnership(
  paths: TestPaths,
  baseline: InstallRecord,
): Promise<InstallRecord> {
  const browserId = "browser@openai-bundled";
  await writeTestConfigValue(paths, `plugins."${browserId}"`, { enabled: true });
  const record = {
    ...baseline,
    version: "0.16.9-1" as const,
    official_plugins: [...new Set([...(baseline.official_plugins ?? []), browserId])],
    capability_state: {
      ...baseline.capability_state!,
      browser_use: {
        ...baseline.capability_state!.browser_use,
        plugin_ids: [browserId],
      },
    },
    provider_config: [
      ...(baseline.provider_config ?? []),
      {
        plugin_id: browserId,
        before: { presence: "absent" as const, digest: "0".repeat(64) },
        after: {
          presence: "present" as const,
          digest: "1".repeat(64),
          safe_value: { kind: "boolean" as const, value: true },
        },
      },
    ],
    plugin_snapshot: [
      ...(baseline.plugin_snapshot ?? []),
      { plugin_id: browserId, status: "missing" as const },
    ],
    owned_plugins: [...new Set([...(baseline.owned_plugins ?? []), browserId])],
  };
  const saved: InstallRecord = {
    ...record,
    digest: await installRecordDigest({
      owner: record.owner,
      install_id: record.install_id,
      version: record.version,
      profile: record.profile,
      tier: record.tier,
      optional_selections: record.optional_selections,
      explicit_optional_selections: record.explicit_optional_selections,
      official_plugins: record.official_plugins ?? [],
      capability_state: record.capability_state ?? null,
      managed_artifacts: record.managed_artifacts,
      managed_config: record.managed_config,
      plugin_config: record.plugin_config,
      provider_config: record.provider_config,
      plugin_snapshot: record.plugin_snapshot,
      owned_plugins: record.owned_plugins,
      tooling: record.tooling,
    }),
  };
  await writeFile(paths.activeRecord, `${JSON.stringify(saved)}\n`);
  return saved;
}

describe("installer preflight", () => {
  test("rejects explicit requests to install the Codex Desktop Browser provider", async () => {
    expect(() => validateInstallOptions({ officialPlugins: ["browser@openai-bundled"] })).toThrow(
      "Browser Use is provided by Codex Desktop/runtime and cannot be installed by the HolyCodex CLI.",
    );
    const events: string[] = [];
    const result = await runCli(
      ["install", "--yes", "--json", "--add-plugin", "browser@openai-bundled"],
      { env: { PATH: "/fake/bin" }, installer: { officialPluginManager: testManager(events) } },
    );
    expect(result.envelope).toMatchObject({
      ok: false,
      error: {
        code: "install_failed",
        message: expect.stringContaining("Select the Browser Use capability instead"),
        details: { plugin_id: "browser@openai-bundled" },
      },
    });
    expect(events).toEqual([]);
  });

  test("treats inherited plugin config keys as absent during install preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-inherited-plugin-keys-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const resolvedConflicts: ManagedConflict[][] = [];
    let review: InstallReview | undefined;
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, '[plugins]\n"toString" = { enabled = false }\n');
      await expect(
        installHolyCodex(
          { ...request, officialPlugins: ["constructor", "toString", "prototype"] },
          {
            paths: { codexHome },
            officialPluginManager: testManager(events),
            runtime: testRuntime(codexHome),
            resolveConflicts: async (conflicts) => {
              resolvedConflicts.push([...conflicts]);
              return Object.fromEntries(
                conflicts.map((conflict) => [conflict.identity!, "replace"]),
              );
            },
            reviewInstall: async (value) => {
              review = value;
              return { action: "cancel" };
            },
          },
        ),
      ).rejects.toMatchObject({ code: "confirmation_required" });

      const pluginConfigConflicts = resolvedConflicts
        .flat()
        .filter((conflict) => conflict.category === "config-key");
      expect(pluginConfigConflicts.map((conflict) => conflict.key)).toEqual(['plugins."toString"']);
      expect(review?.conflicts.map((conflict) => conflict.key)).toEqual(['plugins."toString"']);
      expect(events).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("surfaces malformed TOML with an exact location and a cancel-only conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-invalid-config-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const conflicts: ManagedConflict[][] = [];
    const source = "model = @\n";
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, source);
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: testManager(),
          runtime: testRuntime(codexHome),
          resolveConflicts: async (inventory) => {
            conflicts.push([...inventory]);
            return Object.fromEntries(inventory.map((conflict) => [conflict.identity!, "cancel"]));
          },
        }),
      ).rejects.toMatchObject({
        code: "state_corrupt",
        message: expect.stringContaining(
          `${paths.configFile} contains invalid TOML at line 1, column 9 (offset 8)`,
        ),
        details: { path: paths.configFile, offset: 8, line: 1, column: 9 },
      });

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toHaveLength(1);
      expect(conflicts[0]?.[0]).toMatchObject({
        category: "invalid-config",
        path: paths.configFile,
        defaultDecision: "cancel",
        validDecisions: ["cancel"],
      });
      expect(conflicts[0]?.[0]).not.toHaveProperty("key");
      expect(conflicts[0]?.[0]?.explanation).toContain("Fix the syntax at that location");
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
      await expect(readFile(paths.activeRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("identifies a non-table Codex section before managed configuration merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-invalid-table-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const conflicts: ManagedConflict[][] = [];
    const source = "features = false\n";
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, source);
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: testManager(),
          runtime: testRuntime(codexHome),
          resolveConflicts: async (inventory) => {
            conflicts.push([...inventory]);
            return Object.fromEntries(inventory.map((conflict) => [conflict.identity!, "cancel"]));
          },
        }),
      ).rejects.toMatchObject({
        code: "confirmation_required",
        message: expect.stringContaining("Conflict resolution was cancelled for features at"),
        details: { path: paths.configFile, key: "features" },
      });
      expect(conflicts[0]).toMatchObject([
        {
          category: "invalid-config",
          key: "features",
          existing: false,
          validDecisions: ["remove", "cancel"],
          defaultDecision: "cancel",
        },
      ]);
      expect(conflicts[0]?.[0]?.explanation).toContain(paths.configFile);
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports the concrete invalid value when noninteractive resolution is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-invalid-noninteractive-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const source = "features = false\n";
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, source);
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: testManager(),
          runtime: testRuntime(codexHome),
          resolveConflicts: async () => {
            throw new InstallerError(
              "confirmation_required",
              "Invalid configuration needs an interactive review.",
            );
          },
        }),
      ).rejects.toMatchObject({
        code: "confirmation_required",
        message: expect.stringContaining("features at " + paths.configFile + " = false"),
        details: {
          conflicts: expect.stringContaining("features at " + paths.configFile + " = false"),
        },
      });
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a reviewed non-table section and records the decision in final review", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-remove-invalid-config-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const source = "features = false\n";
    let conflicts: readonly ManagedConflict[] = [];
    let review: InstallReview | undefined;
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, source);
      const result = await installHolyCodex(request, {
        paths: { codexHome },
        officialPluginManager: testManager(),
        runtime: testRuntime(codexHome),
        resolveConflicts: async (inventory) => {
          conflicts = inventory;
          return Object.fromEntries(inventory.map((conflict) => [conflict.identity!, "remove"]));
        },
        reviewInstall: async (value) => {
          review = value;
          return { action: "apply" };
        },
      });

      expect(conflicts).toMatchObject([
        {
          category: "invalid-config",
          target: "features",
          key: "features",
          existing: false,
          desired: expect.stringContaining("create the required table"),
          validDecisions: ["remove", "cancel"],
        },
      ]);
      expect(review?.conflicts.find((conflict) => conflict.key === "features")).toMatchObject({
        existing: false,
        decision: "remove",
        validDecisions: ["remove", "cancel"],
      });
      const document = parseConfig(await readFile(paths.configFile, "utf8"));
      expect(readTestTomlTable(document["features"])["multi_agent_v2"]).toBe(false);
      expect(result.record.managed_config?.managed["features.multi_agent_v2"]).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("preserves an invalid section changed after its removal decision was reviewed", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-invalid-config-race-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const source = "features = false\n";
    const changed = "features = true\n";
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, source);
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: testManager(),
          runtime: testRuntime(codexHome),
          resolveConflicts: async (inventory) =>
            Object.fromEntries(inventory.map((conflict) => [conflict.identity!, "remove"])),
          reviewInstall: async () => {
            await writeFile(paths.configFile, changed);
            return { action: "apply" };
          },
        }),
      ).rejects.toMatchObject({
        code: "confirmation_required",
        message: expect.stringContaining("Invalid configuration at features changed after review"),
        details: { path: paths.configFile, key: "features" },
      });
      expect(await readFile(paths.configFile, "utf8")).toBe(changed);
      await expect(readFile(paths.activeRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("fails before removal mutations when Codex plugin state cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-remove-plugin-list-failure-"));
    const codexHome = join(root, "codex");
    const { manager, runtime, result } = await installBaseline(codexHome);
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const configBefore = await readFile(paths.configFile, "utf8");
    const roleFilesBefore = await Promise.all(
      result.record.managed_artifacts.map(({ path }) => readFile(join(codexHome, path), "utf8")),
    );
    try {
      await expect(
        removeHolyCodex({
          paths: { codexHome },
          officialPluginManager: {
            ...manager,
            list: async () => {
              throw new Error("Codex plugin list unavailable");
            },
          },
          runtime,
          resolveConflict: async () => "accept",
        }),
      ).rejects.toMatchObject({
        code: "capability_denied",
        message: "Codex plugin state could not be read before removing HolyCodex-owned plugins.",
        details: {
          operation: "read Codex plugin state",
          plugins: expect.stringContaining("holycodex@holycodex"),
          recovery: "Repair or expose Codex, then retry removal.",
        },
        causeValue: expect.objectContaining({ message: "Codex plugin list unavailable" }),
      });

      expect(await readFile(paths.configFile, "utf8")).toBe(configBefore);
      expect(
        await Promise.all(
          result.record.managed_artifacts.map(({ path }) =>
            readFile(join(codexHome, path), "utf8"),
          ),
        ),
      ).toEqual(roleFilesBefore);
      expect(await readActiveInstallRecord(paths)).toEqual(result.record);
      await expect(readFile(paths.conflictedRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("repeated removal of absent state succeeds without invoking Codex or creating files", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-remove-absent-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    let managerCalls = 0;
    const manager: OfficialPluginManager = {
      list: async () => {
        managerCalls += 1;
        return { installed: [], available: [] };
      },
      addMarketplace: async () => {
        managerCalls += 1;
      },
      add: async () => {
        managerCalls += 1;
      },
      remove: async () => {
        managerCalls += 1;
      },
    };
    try {
      const options = { paths: { codexHome }, officialPluginManager: manager };
      const first = await removeHolyCodex(options);
      const second = await removeHolyCodex(options);

      expect(first).toEqual({ removed: [], preserved: [], reasons: [] });
      expect(second).toEqual({ removed: [], preserved: [], reasons: [] });
      expect(managerCalls).toBe(0);
      await expect(access(codexHome)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(paths.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps safe diagnostics for unexpected CLI errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-unexpected-cli-error-"));
    const codexHome = join(root, "codex");
    try {
      const result = await runCli(["install", "--yes", "--json", "--codex-home", codexHome], {
        env: { PATH: "/fake/bin" },
        io: { stdoutIsTTY: false, stderrIsTTY: false },
        installer: {
          officialPluginManager: testManager(),
          runtime: testRuntime(codexHome),
          reviewInstall: async () => {
            throw new Error("Bearer top-secret token=abc123 injected review renderer failure");
          },
        },
      });

      expect(result.envelope).toMatchObject({
        ok: false,
        command: "install",
        error: {
          code: "internal_error",
          message: "The install command failed unexpectedly.",
          details: {
            operation: "install",
            cause: "Error: Bearer [redacted] token=[redacted] injected review renderer failure",
          },
        },
      });
      expect(JSON.stringify(result.envelope)).not.toContain("top-secret");
      expect(JSON.stringify(result.envelope)).not.toContain("abc123");
      await expect(
        readFile(resolveInstallerPaths({ paths: { codexHome } }).activeRecord),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("includes sanitized cause and operation for classifiable CLI failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-classified-cli-error-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, 'model = "gpt-5.6-terra"\n');
      const result = await runCli(["install", "--yes", "--json", "--codex-home", codexHome], {
        env: { PATH: "/fake/bin" },
        io: { stdoutIsTTY: false, stderrIsTTY: false },
        installer: {
          officialPluginManager: testManager(),
          runtime: testRuntime(codexHome),
          resolveConflicts: async () => {
            throw new InstallerError(
              "capability_denied",
              "Codex plugin review failed: Bearer top-secret token=abc123",
              new Error("Bearer top-secret token=abc123 plugin list unavailable"),
              { operation: "list Codex plugins", subject: "holycodex@holycodex" },
            );
          },
        },
      });

      expect(result.envelope).toMatchObject({
        ok: false,
        error: {
          code: "capability_denied",
          message: "Codex plugin review failed: Bearer [redacted] token=[redacted]",
          details: {
            operation: "list Codex plugins",
            subject: "holycodex@holycodex",
            cause: "Error: Bearer [redacted] token=[redacted] plugin list unavailable",
          },
        },
      });
      expect(JSON.stringify(result.envelope)).not.toContain("top-secret");
      expect(JSON.stringify(result.envelope)).not.toContain("abc123");
      expect(await readFile(paths.configFile, "utf8")).toBe('model = "gpt-5.6-terra"\n');
      await expect(readFile(paths.activeRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("restores a reviewed non-table section when first-install plugin work fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-remove-invalid-rollback-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const source = "features = false\n";
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, source);
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: configWritingManager(paths, [], true),
          runtime: testRuntime(codexHome),
          resolveConflicts: async (inventory) =>
            Object.fromEntries(inventory.map((conflict) => [conflict.identity!, "remove"])),
        }),
      ).rejects.toThrow("Codex could not add holycodex@holycodex");
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
      await expect(readFile(paths.activeRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("reports the exact user-owned preflight conflict when interactive resolution is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-noninteractive-conflict-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const source = 'model = "gpt-5.6-terra"\n';
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, source);
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: testManager(),
          runtime: testRuntime(codexHome),
          resolveConflicts: async () => {
            throw new InstallerError(
              "confirmation_required",
              "Managed conflicts require an interactive review or --yes.",
            );
          },
        }),
      ).rejects.toMatchObject({
        code: "confirmation_required",
        message: expect.stringContaining(`model at ${paths.configFile}`),
        details: { conflicts: expect.stringContaining("model") },
      });
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
      await expect(readFile(paths.activeRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves multiple removal conflicts through one batch review", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-remove-batch-conflicts-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const { manager, runtime } = await installBaseline(codexHome);
    let batchCalls = 0;
    let singularCalls = 0;
    let reviewed: readonly ManagedConflict[] = [];
    try {
      await writeTestConfigValue(paths, "model", "gpt-5.6-terra");
      await writeTestConfigValue(paths, "features.multi_agent_v2", true);
      const result = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
        resolveConflict: async () => {
          singularCalls += 1;
          return "decline";
        },
        resolveConflicts: async (conflicts) => {
          batchCalls += 1;
          reviewed = conflicts;
          return Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "keep"]));
        },
      });

      expect(batchCalls).toBe(1);
      expect(singularCalls).toBe(0);
      expect(reviewed.length).toBeGreaterThanOrEqual(2);
      expect(new Set(reviewed.map((conflict) => conflict.identity)).size).toBe(reviewed.length);
      expect(result.preserved).toContain(paths.configFile);
      expect(result.reasons).toContain("managed_config_changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("returns a nonzero partial result when removal review keeps edited state", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-remove-kept-exit-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const { manager, runtime } = await installBaseline(codexHome);
    try {
      await writeTestConfigValue(paths, "model", "gpt-5.6-terra");
      const result = await runCli(["remove", "--codex-home", codexHome], {
        env: { CODEX_HOME: codexHome, PATH: "/fake/bin" },
        io: {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          confirm: async () => "confirmed",
        },
        installer: {
          officialPluginManager: manager,
          runtime,
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "keep"])),
        },
      });

      expect(result.exitCode).toBe(4);
      expect(result.envelope).toMatchObject({
        ok: true,
        command: "remove",
        data: {
          removed: [],
          preserved: expect.arrayContaining([paths.configFile]),
          reasons: expect.arrayContaining(["managed_config_changed"]),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("routes live removal review choices, Back, and Cancel without false success", async () => {
    const scenarios = [
      { name: "keep", keys: [{ name: "enter" }], exitCode: 4 },
      { name: "remove", keys: [{ name: "r" }, { name: "enter" }], exitCode: 0 },
      { name: "back", keys: [{ name: "escape" }], exitCode: 4 },
      { name: "cancel", keys: [{ name: "c", ctrl: true }], exitCode: 1 },
    ] as const;

    for (const scenario of scenarios) {
      const root = await mkdtemp(
        join(tmpdir(), `holycodex-preflight-remove-resolver-${scenario.name}-`),
      );
      const codexHome = join(root, "codex");
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const { manager, runtime, result: baseline } = await installBaseline(codexHome);
      try {
        await writeTestConfigValue(paths, "model", "gpt-5.6-terra");
        await mock.module("@opentui/core", () => fakeConflictResolverModule(scenario.keys));
        let result: Awaited<ReturnType<typeof runCli>>;
        try {
          result = await runCli(["remove", "--codex-home", codexHome], {
            io: {
              stdoutIsTTY: true,
              stderrIsTTY: true,
              confirm: async () => "confirmed",
            },
            installer: { officialPluginManager: manager, runtime },
          });
        } finally {
          mock.restore();
        }

        expect(result.exitCode).toBe(scenario.exitCode);
        if (scenario.name === "cancel") {
          expect(result.envelope).toMatchObject({
            ok: false,
            command: "remove",
            error: { code: "confirmation_required" },
          });
          expect(await readActiveInstallRecord(paths)).toEqual(baseline.record);
          expect(parseConfig(await readFile(paths.configFile, "utf8"))["model"]).toBe(
            "gpt-5.6-terra",
          );
        } else if (scenario.name === "remove") {
          expect(result.envelope).toMatchObject({
            ok: true,
            command: "remove",
            data: { preserved: [], reasons: [] },
          });
          expect(await readActiveInstallRecord(paths)).toBeUndefined();
          expect(parseConfig(await readFile(paths.configFile, "utf8"))["model"]).not.toBe(
            "gpt-5.6-terra",
          );
        } else {
          expect(result.envelope).toMatchObject({
            ok: true,
            command: "remove",
            data: {
              removed: [],
              preserved: expect.arrayContaining([paths.configFile]),
              reasons: expect.arrayContaining(["managed_config_changed"]),
            },
          });
          expect(await readActiveInstallRecord(paths)).toEqual(baseline.record);
          expect(parseConfig(await readFile(paths.configFile, "utf8"))["model"]).toBe(
            "gpt-5.6-terra",
          );
        }
      } finally {
        mock.restore();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("refuses a removal choice when a reviewed config value changes before application", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-remove-config-race-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const { manager, runtime, result } = await installBaseline(codexHome, events);
    try {
      await writeTestConfigValue(paths, "model", "gpt-5.6-terra");
      let reviewed: readonly ManagedConflict[] = [];
      await expect(
        removeHolyCodex({
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflicts: async (conflicts) => {
            reviewed = conflicts;
            await writeTestConfigValue(paths, "model", "gpt-5.6-sol");
            return Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "remove"]));
          },
        }),
      ).rejects.toMatchObject({
        code: "confirmation_required",
        message: expect.stringContaining("changed before removal"),
        details: {
          operation: "remove HolyCodex",
          path: paths.configFile,
          key: "model",
          recovery: expect.stringContaining("Run remove again"),
        },
      });

      expect(reviewed).toContainEqual(
        expect.objectContaining({ key: "model", validDecisions: ["keep", "remove", "cancel"] }),
      );
      expect(parseConfig(await readFile(paths.configFile, "utf8"))["model"]).toBe("gpt-5.6-sol");
      expect(events).not.toContain("remove:holycodex@holycodex");
      expect(await readActiveInstallRecord(paths)).toEqual(result.record);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("preserves a native file edited after its removal decision was reviewed", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-remove-native-race-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const { manager, runtime, result } = await installBaseline(codexHome, events);
    const rolePath = await managedRolePath(codexHome, "Explorer.lookup");
    try {
      await writeFile(rolePath, "user edit present before review\n");
      let reviewed: readonly ManagedConflict[] = [];
      await expect(
        removeHolyCodex({
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflicts: async (conflicts) => {
            reviewed = conflicts;
            await writeFile(rolePath, "new user edit after review\n");
            return Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "remove"]));
          },
        }),
      ).rejects.toMatchObject({
        code: "confirmation_required",
        message: expect.stringContaining("changed before removal"),
        details: { operation: "remove HolyCodex", path: rolePath },
      });

      expect(reviewed).toContainEqual(
        expect.objectContaining({ path: rolePath, action: "remove" }),
      );
      expect(await readFile(rolePath, "utf8")).toBe("new user edit after review\n");
      expect(events).not.toContain("remove:holycodex@holycodex");
      expect(await readActiveInstallRecord(paths)).toEqual(result.record);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("reviews and applies keep or replace for user-owned Codex settings on first install", async () => {
    for (const decision of ["keep", "replace"] as const) {
      const root = await mkdtemp(join(tmpdir(), `holycodex-preflight-first-install-${decision}-`));
      const codexHome = join(root, "codex");
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const source =
        'model = "gpt-5.6-terra"\n\n[plugins."holycodex@holycodex"]\nenabled = false\nuser_setting = "preserve"\n';
      let review: InstallReview | undefined;
      try {
        await mkdir(codexHome, { recursive: true });
        await writeFile(paths.configFile, source);
        const result = await installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: testManager(),
          runtime: testRuntime(codexHome),
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(
              conflicts.map((conflict) => [
                conflict.identity!,
                conflict.key === "model" ? decision : "replace",
              ]),
            ),
          reviewInstall: async (value) => {
            review = value;
            return { action: "apply" };
          },
        });

        const modelConflict = review?.conflicts.find((conflict) => conflict.key === "model");
        expect(modelConflict).toMatchObject({
          existing: "gpt-5.6-terra",
          defaultDecision: "keep",
          decision,
        });
        expect(
          review?.conflicts.find((conflict) => conflict.key === 'plugins."holycodex@holycodex"'),
        ).toMatchObject({
          defaultDecision: "replace",
          decision: "replace",
          validDecisions: ["replace", "cancel"],
        });
        const document = parseConfig(await readFile(paths.configFile, "utf8"));
        expect(readTestConfigEntry(document, "plugins", "holycodex@holycodex")).toEqual({
          enabled: true,
        });
        if (decision === "keep") {
          expect(document["model"]).toBe("gpt-5.6-terra");
          expect(result.record.managed_config?.managed["model"]).toBeUndefined();
        } else {
          expect(document["model"]).toBe("gpt-6.1-sol");
          expect(result.record.managed_config?.managed["model"]).toBeDefined();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("restores first-install user configuration after a plugin failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-first-install-rollback-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const source =
      'model = "gpt-5.6-terra"\n\n[plugins."holycodex@holycodex"]\nenabled = false\nuser_setting = "preserve"\n';
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(paths.configFile, source);
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: configWritingManager(paths, [], true),
          runtime: testRuntime(codexHome),
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "replace"])),
        }),
      ).rejects.toThrow("Codex could not add holycodex@holycodex");
      const restored = parseConfig(await readFile(paths.configFile, "utf8"));
      expect(restored["model"]).toBe("gpt-5.6-terra");
      expect(readTestConfigEntry(restored, "plugins", "holycodex@holycodex")).toEqual({
        enabled: false,
        user_setting: "preserve",
      });
      await expect(readFile(paths.activeRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("diagnoses stale and incompatible transaction journals", () => {
    const stale = diagnoseInstallTransactions(
      { install_id: "active", digest: "a" },
      { install_id: "stale", digest: "b" },
      undefined,
    );
    expect(stale).toEqual([
      {
        status: "preparing",
        relation: "stale",
        install_id: "stale",
        digest: "b",
        recovery: "inspect",
        active_install_id: "active",
        active_digest: "a",
      },
    ]);
    expect(() =>
      assertInstallTransactionState(
        { install_id: "active", digest: "a" },
        { install_id: "stale", digest: "b" },
        undefined,
      ),
    ).toThrow("stale or incompatible transaction state");

    const incompatible = diagnoseInstallTransactions(
      undefined,
      { install_id: "preparing", digest: "a" },
      { install_id: "conflicted", digest: "b" },
    );
    expect(incompatible.every((diagnosis) => diagnosis.relation === "incompatible")).toBe(true);
    expect(incompatible.every((diagnosis) => diagnosis.recovery === "inspect")).toBe(true);

    const recoverable = diagnoseInstallTransactions(
      undefined,
      { install_id: "same", digest: "same" },
      { install_id: "same", digest: "same" },
    );
    expect(recoverable.every((diagnosis) => diagnosis.relation === "orphaned")).toBe(true);
    expect(recoverable.every((diagnosis) => diagnosis.recovery === "reconcile")).toBe(true);
    expect(() =>
      assertInstallTransactionState(
        undefined,
        { install_id: "same", digest: "same" },
        { install_id: "same", digest: "same" },
      ),
    ).not.toThrow();
    expect(() =>
      assertRemovalTransactionState(
        undefined,
        { install_id: "same", digest: "same" },
        { install_id: "same", digest: "same" },
      ),
    ).not.toThrow();
  });

  test("reports stale state before mutation and exposes recovery in doctor", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-stale-"));
    const codexHome = join(root, "codex");
    const events: string[] = [];
    try {
      const { manager, runtime } = await installBaseline(codexHome, events);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const configBefore = await readFile(paths.configFile, "utf8");
      const active = JSON.parse(await readFile(paths.activeRecord, "utf8")) as Record<
        string,
        unknown
      >;
      await writeFile(
        paths.preparingRecord,
        JSON.stringify({
          ...active,
          install_id: "stalejournal",
          status: "preparing",
          step: "roles_prepared",
        }),
      );
      events.length = 0;

      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
        }),
      ).rejects.toMatchObject({ code: "state_corrupt" });
      expect(events).toEqual([]);
      expect(await readFile(paths.configFile, "utf8")).toBe(configBefore);

      const doctor = await doctorHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
      });
      expect(doctor.healthy).toBe(false);
      expect(doctor.checks["transaction"]?.reasons).toContain("stale_transaction_state");
      expect(doctor.checks["transaction"]?.details["transactions"]).toContain(
        "preparing:stale:stalejournal",
      );
      expect(doctor.checks["transaction"]?.details["recovery"]).toBe("inspect");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers a preparing journal written with the prior install schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-legacy-journal-"));
    const codexHome = join(root, "codex");
    try {
      const { manager, runtime, result } = await installBaseline(codexHome);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const legacySelections = {
        computer_use: result.record.optional_selections.computer_use,
        frontend: true,
        security: true,
        coding: true as const,
        work: false,
      };
      const legacyExplicit = {
        frontend: false,
        security: false,
        work: false,
      };
      const legacyRecord = {
        ...result.record,
        optional_selections: legacySelections,
        explicit_optional_selections: legacyExplicit,
        capability_state: {
          computer_use: result.record.capability_state!.computer_use,
          frontend: result.record.capability_state!.frontend,
          security: result.record.capability_state!.security,
          work: {
            selected: false,
            status: "disabled" as const,
            plugin_ids: [],
          },
        },
      };
      legacyRecord.digest = await installRecordDigest({
        owner: legacyRecord.owner,
        install_id: legacyRecord.install_id,
        version: legacyRecord.version,
        profile: legacyRecord.profile,
        tier: legacyRecord.tier,
        optional_selections: legacyRecord.optional_selections,
        explicit_optional_selections: legacyRecord.explicit_optional_selections,
        official_plugins: legacyRecord.official_plugins ?? [],
        capability_state: legacyRecord.capability_state,
        managed_artifacts: legacyRecord.managed_artifacts,
        managed_config: legacyRecord.managed_config,
        plugin_config: legacyRecord.plugin_config,
        provider_config: legacyRecord.provider_config,
        plugin_snapshot: legacyRecord.plugin_snapshot,
        owned_plugins: legacyRecord.owned_plugins,
        tooling: legacyRecord.tooling,
      });
      await writeFile(paths.activeRecord, `${JSON.stringify(legacyRecord)}\n`);
      const journal = {
        ...legacyRecord,
        status: "preparing" as const,
        step: "plugins_installed" as const,
      };
      const configBefore = await readFile(paths.configFile, "utf8");
      for (const stale of [
        { ...journal, digest: "f".repeat(64) },
        { ...journal, install_id: "different-install" },
      ]) {
        await writeFile(paths.preparingRecord, `${JSON.stringify(stale)}\n`);
        await expect(
          installHolyCodex(request, {
            paths: { codexHome },
            officialPluginManager: manager,
            runtime,
          }),
        ).rejects.toMatchObject({ code: "state_corrupt" });
        expect(await readFile(paths.configFile, "utf8")).toBe(configBefore);
      }
      await writeFile(paths.preparingRecord, `${JSON.stringify(journal)}\n`);

      const removal = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
      });
      expect(removal.reasons).toEqual([]);
      expect(await readFile(paths.activeRecord).catch(() => undefined)).toBeUndefined();
      expect(await readFile(paths.preparingRecord).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("does not mutate managed state before final review approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-review-"));
    const codexHome = join(root, "codex");
    const events: string[] = [];
    let review: InstallReview | undefined;
    try {
      const manager = testManager(events);
      const runtime = testRuntime(codexHome);
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          reviewInstall: async (value) => {
            review = value;
            return { action: "cancel" };
          },
        }),
      ).rejects.toMatchObject({ code: "confirmation_required" });
      expect(review?.conflicts).toEqual([]);
      expect(review?.conflictCounts).toEqual({});
      expect(review?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "context7", status: "unavailable" }),
        ]),
      );
      expect(events).toEqual([]);
      await expect(
        readFile(resolveInstallerPaths({ paths: { codexHome } }).activeRecord),
      ).rejects.toThrow();
      await expect(
        readFile(resolveInstallerPaths({ paths: { codexHome } }).configFile),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor describes Browser Use as surface-managed without failing health", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-browser-doctor-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const { result, runtime } = await installBaseline(codexHome);
    const legacy = await writeLegacyBrowserOwnership(paths, result.record);
    const requested: string[][] = [];
    const manager: OfficialPluginManager = {
      ...testManager(),
      status: async (ids) => {
        requested.push([...ids]);
        return Object.fromEntries(ids.map((id) => [id, "installed" as const]));
      },
    };
    try {
      const doctor = await doctorHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
      });

      expect(legacy.owned_plugins).toContain("browser@openai-bundled");
      expect((await readActiveInstallRecord(paths))?.version).toBe(legacy.version);
      expect(doctor.healthy).toBe(true);
      expect(doctor.checks["browser_use"]).toMatchObject({
        status: "unsupported",
        reasons: ["surface_managed_by_codex_desktop"],
        details: {
          selected: true,
          owner: "Codex Desktop/runtime",
          cli_provisioning: "HolyCodex CLI does not install, configure, or verify Browser.",
        },
      });
      expect(requested.flat()).not.toContain("browser@openai-bundled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("upgrade ignores historical Browser ownership and preserves host config", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-browser-upgrade-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const { result, runtime } = await installBaseline(codexHome, events);
    await writeLegacyBrowserOwnership(paths, result.record);
    const manager = withBrowserListed(testManager(events));
    try {
      const dryRun = await upgradeHolyCodex(
        { paths: { codexHome }, officialPluginManager: manager, runtime },
        process.env,
        { dryRun: true, options: { optional: { sites: false } } },
      );
      expect(dryRun.conflicts?.some((conflict) => conflict.key?.includes("browser@"))).toBe(false);

      const upgraded = await upgradeHolyCodex(
        { paths: { codexHome }, officialPluginManager: manager, runtime },
        process.env,
        { options: { optional: { sites: false } } },
      );
      expect(upgraded.status).toBe("upgraded");
      expect(events).not.toContain("remove:browser@openai-bundled");
      expect(upgraded.record?.owned_plugins).not.toContain("browser@openai-bundled");
      expect(upgraded.record?.official_plugins).not.toContain("browser@openai-bundled");
      expect(upgraded.record?.provider_config?.map((entry) => entry.plugin_id)).not.toContain(
        "browser@openai-bundled",
      );
      expect(
        readTestConfigEntry(
          parseConfig(await readFile(paths.configFile, "utf8")),
          "plugins",
          "browser@openai-bundled",
        ),
      ).toEqual({ enabled: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("remove ignores historical Browser ownership and preserves host config", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-browser-remove-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const { result, runtime } = await installBaseline(codexHome, events);
    await writeLegacyBrowserOwnership(paths, result.record);
    const manager = withBrowserListed(testManager(events));
    try {
      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
      });

      expect(removed.reasons).toEqual([]);
      expect(events).not.toContain("remove:browser@openai-bundled");
      expect(
        readTestConfigEntry(
          parseConfig(await readFile(paths.configFile, "utf8")),
          "plugins",
          "browser@openai-bundled",
        ),
      ).toEqual({ enabled: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("creates a fresh Codex config only after review and before marketplace setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-fresh-config-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const delegate = testManager(events);
    const manager: OfficialPluginManager = {
      ...delegate,
      addMarketplace: async (source) => {
        const config = await readFile(paths.configFile, "utf8").catch(() => undefined);
        if (config === undefined) {
          throw new Error("config.toml is missing before Codex marketplace setup");
        }
        if (config !== "") {
          throw new Error("the temporary Codex config changed before marketplace setup");
        }
        await delegate.addMarketplace?.(source);
      },
    };
    let configDuringReview: string | undefined;
    try {
      const result = await installHolyCodex(request, {
        paths: { codexHome },
        officialPluginManager: manager,
        runtime: testRuntime(codexHome),
        reviewInstall: async () => {
          configDuringReview = await readFile(paths.configFile, "utf8").catch(() => undefined);
          return { action: "apply" };
        },
      });

      expect(configDuringReview).toBeUndefined();
      expect(await readFile(paths.configFile, "utf8")).toContain('model = "gpt-6.1-sol"');
      expect(result.record.capability_state?.browser_use.selected).toBe(true);
      expect(events.some((event) => event === "add:browser@openai-bundled")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("warns Windows users to install Git for Bash during preflight review", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-windows-git-bash-"));
    const codexHome = join(root, "codex");
    let review: InstallReview | undefined;
    try {
      const runtime = { ...testRuntime(codexHome), platform: "win32" as const };
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: testManager(),
          runtime,
          reviewInstall: async (value) => {
            review = value;
            return { action: "cancel" };
          },
        }),
      ).rejects.toMatchObject({ code: "confirmation_required" });
      expect(review?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "git-bash",
            status: "missing",
            detail: expect.stringContaining("winget install Git.Git"),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed after independent config and registered-role conflict decisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-conflicts-"));
    const codexHome = join(root, "codex");
    try {
      const { manager, runtime } = await installBaseline(codexHome);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      await writeFile(
        paths.configFile,
        (await readFile(paths.configFile, "utf8"))
          .replace('model = "gpt-6.1-sol"', 'model = "gpt-5.6-terra"')
          .replace("experimental_mode = true", "experimental_mode = false"),
      );
      const rolePath = await managedRolePath(codexHome, "Worker.implementation");
      const userRole = (await readFile(rolePath, "utf8")).replace(
        'model_reasoning_summary = "none"',
        'model_reasoning_summary = "detailed"',
      );
      await writeFile(rolePath, userRole);
      let review: InstallReview | undefined;

      const conflictedConfig = await readFile(paths.configFile, "utf8");
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflict: async (conflict) =>
            conflict.category === "role-asset" || conflict.key === "model" ? "decline" : "accept",
          reviewInstall: async (value) => {
            review = value;
            return { action: "apply" };
          },
        }),
      ).rejects.toMatchObject({
        code: "install_failed",
        message: expect.stringContaining(
          "role file was kept after a conflict and cannot be activated",
        ),
      });

      expect(review?.conflictCounts["config-key"]).toBeGreaterThanOrEqual(2);
      expect(review?.conflictCounts["role-asset"]).toBeGreaterThanOrEqual(1);
      expect(await readFile(paths.configFile, "utf8")).toBe(conflictedConfig);
      expect(await readFile(rolePath, "utf8")).toBe(userRole);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("fails closed for a kept role after batch conflict review without pre-review mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-batch-conflicts-"));
    const codexHome = join(root, "codex");
    const events: string[] = [];
    const batchConflicts: ManagedConflict[][] = [];
    const callbackConfigs: string[] = [];
    const callbackRoles: string[] = [];
    const callbackEvents: string[][] = [];
    const reviews: InstallReview[] = [];
    try {
      const { manager, runtime } = await installBaseline(codexHome, events);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      await writeFile(
        paths.configFile,
        (await readFile(paths.configFile, "utf8"))
          .replace('model = "gpt-6.1-sol"', 'model = "gpt-5.6-terra"')
          .replace("experimental_mode = true", 'experimental_mode = false\nunrelated = "keep"'),
      );
      const rolePath = await managedRolePath(codexHome, "Worker.implementation");
      const userRole = (await readFile(rolePath, "utf8")).replace(
        'model_reasoning_summary = "none"',
        'model_reasoning_summary = "detailed"',
      );
      await writeFile(rolePath, userRole);
      const preflightConfig = await readFile(paths.configFile, "utf8");
      const preflightRole = await readFile(rolePath, "utf8");
      events.length = 0;

      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflicts: async (conflicts) => {
            batchConflicts.push([...conflicts]);
            callbackConfigs.push(await readFile(paths.configFile, "utf8"));
            callbackRoles.push(await readFile(rolePath, "utf8"));
            callbackEvents.push([...events]);
            return Object.fromEntries(
              conflicts.map((conflict) => [
                conflict.identity!,
                conflict.category === "config-key" && conflict.key === "model" ? "replace" : "keep",
              ]),
            );
          },
          reviewInstall: async (review) => {
            reviews.push(review);
            expect(await readFile(paths.configFile, "utf8")).toBe(preflightConfig);
            expect(await readFile(rolePath, "utf8")).toBe(preflightRole);
            expect(events).toEqual([]);
            return { action: "apply" };
          },
        }),
      ).rejects.toMatchObject({
        code: "install_failed",
        message: expect.stringContaining(
          "role file was kept after a conflict and cannot be activated",
        ),
      });

      expect(batchConflicts).toHaveLength(1);
      expect(batchConflicts[0]?.some((conflict) => conflict.category === "role-asset")).toBe(true);
      expect(
        batchConflicts[0]?.some(
          (conflict) => conflict.category === "config-key" && conflict.key === "model",
        ),
      ).toBe(true);
      expect(
        batchConflicts[0]?.some(
          (conflict) =>
            conflict.category === "config-key" &&
            conflict.key === "features.context_management.experimental_mode",
        ),
      ).toBe(true);
      expect(callbackConfigs).toEqual([preflightConfig]);
      expect(callbackRoles).toEqual([preflightRole]);
      expect(callbackEvents).toEqual([[]]);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.conflictCounts["config-key"]).toBeGreaterThanOrEqual(2);
      expect(reviews[0]?.conflictCounts["role-asset"]).toBeGreaterThanOrEqual(1);
      expect(await readFile(paths.configFile, "utf8")).toBe(preflightConfig);
      expect(await readFile(rolePath, "utf8")).toBe(preflightRole);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("restores a kept managed setting after native plugin health reinstalls", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-kept-health-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    let rewriteOnAdd = false;
    try {
      const manager = configWritingManager(paths, events, false, undefined, async (pluginId) => {
        if (rewriteOnAdd && pluginId === "holycodex@holycodex") {
          await writeTestConfigValue(paths, "model", "gpt-6-health");
        }
      });
      const runtime = testRuntime(codexHome);
      await installHolyCodex(request, {
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
      });
      rewriteOnAdd = true;
      await manager.remove?.("holycodex@holycodex");
      await writeTestConfigValue(paths, "model", "gpt-5.6-terra");
      await writeTestConfigValue(paths, "features.context_management.experimental_mode", false);
      await writeTestConfigValue(paths, "unrelated", "keep");

      await installHolyCodex(request, {
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
        resolveConflicts: async (conflicts) =>
          Object.fromEntries(
            conflicts.map((conflict) => [
              conflict.identity!,
              conflict.key === "features.context_management.experimental_mode" ? "replace" : "keep",
            ]),
          ),
        reviewInstall: async () => ({ action: "apply" }),
      });

      const finalConfig = await readFile(paths.configFile, "utf8");
      expect(finalConfig).toContain('model = "gpt-5.6-terra"');
      expect(finalConfig).toContain("experimental_mode = true");
      expect(finalConfig).toContain('unrelated = "keep"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("fails closed when reopened conflict resolution keeps a registered role", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-resolve-"));
    const codexHome = join(root, "codex");
    try {
      const { manager, runtime } = await installBaseline(codexHome);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const rolePath = await managedRolePath(codexHome, "Worker.implementation");
      const userRole = (await readFile(rolePath, "utf8")).replace(
        'model_reasoning_summary = "none"',
        'model_reasoning_summary = "detailed"',
      );
      await writeFile(rolePath, userRole);
      const reviews: InstallReview[] = [];
      let reviewCalls = 0;

      const preflightRole = await readFile(rolePath, "utf8");
      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflict: async () => "decline",
          reviewInstall: async (value) => {
            reviews.push(value);
            reviewCalls += 1;
            return reviewCalls === 1 ? { action: "resolve" } : { action: "apply" };
          },
        }),
      ).rejects.toMatchObject({
        code: "install_failed",
        message: expect.stringContaining(
          "role file was kept after a conflict and cannot be activated",
        ),
      });

      expect(reviews).toHaveLength(2);
      expect(reviews[0]?.conflictCounts["role-asset"]).toBeGreaterThanOrEqual(1);
      expect(reviews[1]?.conflictCounts["role-asset"]).toBeGreaterThanOrEqual(1);
      expect(await readFile(rolePath, "utf8")).toBe(preflightRole);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects a native role replacement decision when the reviewed file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-stale-role-review-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    try {
      const { manager, runtime, result: baseline } = await installBaseline(codexHome, events);
      const rolePath = await managedRolePath(codexHome, "Worker.implementation");
      const initialRole = await readFile(rolePath, "utf8");
      await writeFile(
        rolePath,
        initialRole.replace(
          'model_reasoning_summary = "none"',
          'model_reasoning_summary = "detailed"',
        ),
      );
      const latestRole = initialRole.replace(
        'model_reasoning_summary = "none"',
        'model_reasoning_summary = "concise"',
      );
      const beforeAttemptEvents = [...events];

      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "replace"])),
          reviewInstall: async (review) => {
            expect(review.conflicts.find((conflict) => conflict.path === rolePath)?.decision).toBe(
              "replace",
            );
            await writeFile(rolePath, latestRole);
            return { action: "apply" };
          },
        }),
      ).rejects.toMatchObject({ code: "install_failed" });

      expect(await readFile(rolePath, "utf8")).toBe(latestRole);
      expect(await readActiveInstallRecord(paths)).toEqual(baseline.record);
      expect(events).toEqual(beforeAttemptEvents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects plugin config decisions when plugin and provider entries change after review", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-stale-plugin-review-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const frontendRequest: InstallRequest = {
      optional: {},
    };
    try {
      const manager = configWritingManager(paths, events);
      const runtime = testRuntime(codexHome);
      const baseline = await installHolyCodex(frontendRequest, {
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
      });
      await writeTestConfigValue(paths, 'plugins."holycodex@holycodex"', { enabled: false });
      await writeTestConfigValue(paths, 'plugins."build-web-apps@openai-curated"', {
        enabled: false,
      });
      const beforeAttemptEvents = [...events];
      const latestPluginConfig = { enabled: false, user_edit: "latest plugin edit" };
      const latestProviderConfig = { enabled: false, user_edit: "latest provider edit" };

      await expect(
        installHolyCodex(frontendRequest, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "replace"])),
          reviewInstall: async (review) => {
            expect(review.conflicts.map((conflict) => conflict.key)).toEqual(
              expect.arrayContaining([
                'plugins."holycodex@holycodex"',
                'plugins."build-web-apps@openai-curated"',
              ]),
            );
            await writeTestConfigValue(paths, 'plugins."holycodex@holycodex"', latestPluginConfig);
            await writeTestConfigValue(
              paths,
              'plugins."build-web-apps@openai-curated"',
              latestProviderConfig,
            );
            return { action: "apply" };
          },
        }),
      ).rejects.toMatchObject({ code: "confirmation_required" });

      const latestConfig = parseConfig(await readFile(paths.configFile, "utf8"));
      expect(readTestConfigEntry(latestConfig, "plugins", "holycodex@holycodex")).toEqual(
        latestPluginConfig,
      );
      expect(readTestConfigEntry(latestConfig, "plugins", "build-web-apps@openai-curated")).toEqual(
        latestProviderConfig,
      );
      expect(await readActiveInstallRecord(paths)).toEqual(baseline.record);
      expect(events).toEqual(beforeAttemptEvents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("restores the previous install config after a failed transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-rollback-"));
    const codexHome = join(root, "codex");
    try {
      const { runtime } = await installBaseline(codexHome);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const configBefore = await readFile(paths.configFile, "utf8");
      const managerBase = testManager();
      const manager: OfficialPluginManager = {
        ...managerBase,
        addMarketplace: async () => {
          await writeFile(
            paths.configFile,
            `${await readFile(paths.configFile, "utf8")}\nunrelated = "user mutation"\n`,
          );
          throw new Error("marketplace unavailable");
        },
      };

      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
        }),
      ).rejects.toMatchObject({ code: "install_failed" });
      expect(await readFile(paths.configFile, "utf8")).toContain('unrelated = "user mutation"');
      expect(await readFile(paths.configFile, "utf8")).not.toBe(configBefore);
      await expect(readFile(paths.preparingRecord)).rejects.toThrow();
      await expect(readFile(paths.conflictedRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("restores unsupported plugin fields after a failed transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-rollback-custom-"));
    const codexHome = join(root, "codex");
    const events: string[] = [];
    try {
      await installBaseline(codexHome);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      await writeTestConfigValue(paths, 'plugins."holycodex@holycodex"', {
        enabled: true,
        custom_field: "preserve",
      });
      const manager = configWritingManager(paths, events, true, undefined, async (pluginId) => {
        if (pluginId === "holycodex@holycodex") {
          await writeTestConfigValue(paths, "unrelated", "keep");
        }
      });

      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime: testRuntime(codexHome),
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "keep"])),
        }),
      ).rejects.toMatchObject({ code: "capability_denied" });

      const rolledBack = parseConfig(await readFile(paths.configFile, "utf8"));
      expect(readTestConfigEntry(rolledBack, "plugins", "holycodex@holycodex")).toEqual({
        enabled: true,
        custom_field: "preserve",
      });
      expect(rolledBack["unrelated"]).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("publishes conflicted recovery after fresh-install plugin rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-fresh-recovery-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const manager = configWritingManager(paths, events, true);
    const runtime = testRuntime(codexHome);
    const frontendRequest: InstallRequest = {
      optional: {},
    };
    try {
      await expect(
        installHolyCodex(frontendRequest, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
        }),
      ).rejects.toMatchObject({ code: "capability_denied" });

      const rolledBackConfig = parseConfig(await readFile(paths.configFile, "utf8"));
      expect(
        readTestConfigEntry(rolledBackConfig, "plugins", "holycodex@holycodex"),
      ).toBeUndefined();
      expect(readTestConfigEntry(rolledBackConfig, "marketplaces", "holycodex")).toBeUndefined();
      expect(
        readTestConfigEntry(rolledBackConfig, "plugins", "build-web-apps@openai-curated"),
      ).toBeUndefined();
      expect(await readActiveInstallRecord(paths)).toBeUndefined();
      expect(await readFile(paths.conflictedRecord, "utf8")).toContain('"status":"conflicted"');
      await expect(readFile(paths.preparingRecord)).rejects.toThrow();

      const removal = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
        resolveConflict: async () => "accept",
      });
      expect(removal.reasons).toEqual([]);
      expect(events).toContain("remove:holycodex@holycodex");
      await expect(readFile(paths.conflictedRecord)).rejects.toThrow();
      await expect(readFile(paths.preparingRecord)).rejects.toThrow();

      const retry = await installHolyCodex(frontendRequest, {
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
      });
      expect(retry.record.status).toBe("active");
      expect(await readActiveInstallRecord(paths)).toEqual(retry.record);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("recovery batches multiple conflicts and stops before mutations when one is kept", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-recovery-batch-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const { manager, runtime, result } = await installBaseline(codexHome, events);
    const configBeforeRetry = await readFile(paths.configFile, "utf8");
    try {
      await writeTestConfigValue(paths, "model", "gpt-5.6-terra");
      await writeTestConfigValue(paths, "features.multi_agent_v2", true);
      const conflictedConfig = await readFile(paths.configFile, "utf8");
      await writeFile(
        paths.conflictedRecord,
        `${JSON.stringify({ ...result.record, status: "conflicted", step: "conflicted" })}\n`,
      );
      const eventsBeforeRetry = [...events];
      let preserveReviewCalls = 0;
      let preserveLegacyCalls = 0;
      let preserveInventory: readonly ManagedConflict[] = [];

      await expect(
        installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflict: async () => {
            preserveLegacyCalls += 1;
            return "accept";
          },
          resolveConflicts: async (conflicts) => {
            preserveReviewCalls += 1;
            preserveInventory = conflicts;
            return Object.fromEntries(
              conflicts.map((conflict) => [
                conflict.identity!,
                conflict.key === "model" ? "keep" : "remove",
              ]),
            );
          },
        }),
      ).rejects.toMatchObject({
        code: "state_corrupt",
        message: expect.stringContaining("could not be reconciled safely"),
      });

      expect(preserveReviewCalls).toBe(1);
      expect(preserveLegacyCalls).toBe(0);
      expect(preserveInventory.length).toBeGreaterThanOrEqual(2);
      expect(preserveInventory.map((conflict) => conflict.key)).toEqual(
        expect.arrayContaining(["model", "features.multi_agent_v2"]),
      );
      expect(events).toEqual(eventsBeforeRetry);
      expect(await readFile(paths.configFile, "utf8")).toBe(conflictedConfig);
      expect(await readFile(paths.configFile, "utf8")).not.toBe(configBeforeRetry);
      expect(await readActiveInstallRecord(paths)).toEqual(result.record);
      await expect(readFile(paths.conflictedRecord)).resolves.toBeTruthy();

      let replaceReviewCalls = 0;
      let replaceLegacyCalls = 0;
      let replaceInventory: readonly ManagedConflict[] = [];
      const retried = await installHolyCodex(request, {
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
        resolveConflict: async () => {
          replaceLegacyCalls += 1;
          return "accept";
        },
        resolveConflicts: async (conflicts) => {
          replaceReviewCalls += 1;
          replaceInventory = conflicts;
          return Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "remove"]));
        },
      });

      expect(replaceReviewCalls).toBe(1);
      expect(replaceLegacyCalls).toBe(0);
      expect(replaceInventory.length).toBeGreaterThanOrEqual(2);
      expect(retried.record.status).toBe("active");
      const resolvedConfig = parseConfig(await readFile(paths.configFile, "utf8"));
      expect(resolvedConfig["model"]).toBe("gpt-6.1-sol");
      expect(readTestTomlTable(resolvedConfig["features"])["multi_agent_v2"]).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("persists plugin ownership before a mid-loop failure and recovers it", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-mid-plugin-recovery-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const events: string[] = [];
    const observedOwnedPlugins: string[][] = [];
    const providerPlugin = "build-web-apps@openai-curated";
    const manager = configWritingManager(paths, events, false, providerPlugin, async (pluginId) => {
      if (pluginId !== providerPlugin) return;
      const preparing = JSON.parse(await readFile(paths.preparingRecord, "utf8")) as {
        owned_plugins?: string[];
      };
      observedOwnedPlugins.push(preparing.owned_plugins ?? []);
    });
    const runtime = testRuntime(codexHome);
    const frontendRequest: InstallRequest = {
      optional: {},
    };
    try {
      await expect(
        installHolyCodex(frontendRequest, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
        }),
      ).rejects.toMatchObject({ code: "capability_denied" });

      expect(observedOwnedPlugins).toEqual([["holycodex@holycodex"]]);
      const conflicted = JSON.parse(await readFile(paths.conflictedRecord, "utf8")) as {
        owned_plugins?: string[];
      };
      expect(conflicted.owned_plugins).toEqual(["holycodex@holycodex", providerPlugin]);

      const removal = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
        resolveConflict: async () => "accept",
      });
      expect(removal.reasons).toEqual([]);
      expect(events).toContain(`remove:${providerPlugin}`);
      await expect(readFile(paths.conflictedRecord)).rejects.toThrow();
      await expect(readFile(paths.preparingRecord)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps the active install intact when adding a replacement plugin fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-disabled-rollback-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const oldPlugin = "sample@openai-curated";
    const replacementPlugin = "replacement@openai-curated";
    const states = new Map<string, { installed: boolean; enabled: boolean }>();
    const manager: OfficialPluginManager = {
      list: async () => ({
        installed: [...states]
          .filter(([, state]) => state.installed)
          .map(([pluginId, state]) => ({ pluginId, ...state })),
        available: [...states]
          .filter(([, state]) => !state.installed)
          .map(([pluginId, state]) => ({ pluginId, ...state })),
      }),
      addMarketplace: async () => undefined,
      add: async (pluginId) => {
        if (pluginId === replacementPlugin) throw new Error("replacement unavailable");
        states.set(pluginId, { installed: true, enabled: true });
      },
      remove: async (pluginId) => {
        states.delete(pluginId);
      },
    };
    const runtime = testRuntime(codexHome);
    try {
      const initial = await installHolyCodex(
        {
          optional: { computer_use: false },
          officialPlugins: [oldPlugin],
        },
        { paths: { codexHome }, officialPluginManager: manager, runtime },
      );
      expect(initial.record.owned_plugins).toContain(oldPlugin);
      states.set(oldPlugin, { installed: true, enabled: false });

      await expect(
        installHolyCodex(
          {
            optional: { computer_use: false },
            officialPlugins: [replacementPlugin],
          },
          { paths: { codexHome }, officialPluginManager: manager, runtime },
        ),
      ).rejects.toMatchObject({ code: "capability_denied" });

      expect(await readActiveInstallRecord(paths)).toEqual(initial.record);
      await expect(readFile(paths.conflictedRecord)).rejects.toThrow();
      await expect(readFile(paths.preparingRecord)).rejects.toThrow();
      await expect(manager.list?.()).resolves.toMatchObject({
        installed: expect.arrayContaining([
          expect.objectContaining({ pluginId: oldPlugin, installed: true, enabled: false }),
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("persists recovery when install options removal fails and removes it on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-options-removal-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const { manager, runtime } = await installBaseline(codexHome);
    let failOptionsRemoval = true;
    const mockedRm = async (...args: Parameters<typeof realRm>) => {
      const [path] = args;
      if (failOptionsRemoval && path.toString() === paths.installOptions) {
        failOptionsRemoval = false;
        throw Object.assign(new Error("injected install options removal failure"), {
          code: "EACCES",
        });
      }
      return await realRm(...args);
    };
    await mock.module("node:fs/promises", () => ({ ...realFs, rm: mockedRm }));
    try {
      const maintenanceModulePath: string = "./maintenance.ts?install-options-removal-recovery";
      const maintenance = (await import(
        maintenanceModulePath
      )) as typeof import("./maintenance.ts");
      const failedRemoval = await maintenance.removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
        resolveConflict: async () => "accept",
      });
      expect(failedRemoval.preserved).toContain(paths.installOptions);
      expect(failedRemoval.reasons).toContain("state_remove_failed");
      await expect(readFile(paths.activeRecord, "utf8")).rejects.toThrow();
      await expect(readFile(paths.installOptions, "utf8")).resolves.toBeTruthy();
      await expect(readFile(paths.conflictedRecord, "utf8")).resolves.toContain(
        '"status":"conflicted"',
      );

      const retry = await maintenance.removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
        resolveConflict: async () => "accept",
      });
      expect(retry.preserved).toEqual([]);
      expect(retry.reasons).toEqual([]);
      await expect(readFile(paths.installOptions, "utf8")).rejects.toThrow();
      await expect(readFile(paths.conflictedRecord, "utf8")).rejects.toThrow();
    } finally {
      mock.restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("applies plugin and provider conflict decisions to config and snapshots", async () => {
    for (const decision of ["keep", "replace"] as const) {
      const root = await mkdtemp(
        join(tmpdir(), `holycodex-preflight-plugin-conflict-${decision}-`),
      );
      const codexHome = join(root, "codex");
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const manager = configWritingManager(paths);
      const runtime = testRuntime(codexHome);
      const frontendRequest: InstallRequest = {
        optional: {},
      };
      try {
        await installHolyCodex(frontendRequest, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
        });
        const keptPluginConfig = { enabled: true, user_setting: "preserve" };
        const selectedPluginConfig = decision === "keep" ? keptPluginConfig : { enabled: false };
        await writeTestConfigValue(paths, 'plugins."holycodex@holycodex"', selectedPluginConfig);
        await writeTestConfigValue(paths, "marketplaces.holycodex", {
          source_type: "git",
          source: "https://example.test/custom-holycodex.git",
        });
        const selectedProviderConfig = decision === "keep" ? keptPluginConfig : { enabled: false };
        await writeTestConfigValue(
          paths,
          'plugins."build-web-apps@openai-curated"',
          selectedProviderConfig,
        );
        const conflictKeys: string[] = [];
        const result = await installHolyCodex(frontendRequest, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflicts: async (conflicts) => {
            conflictKeys.push(...conflicts.map((conflict) => conflict.key ?? ""));
            return Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, decision]));
          },
        });

        expect(conflictKeys).toEqual(
          expect.arrayContaining([
            'plugins."holycodex@holycodex"',
            "marketplaces.holycodex",
            'plugins."build-web-apps@openai-curated"',
          ]),
        );
        const serialized = await readFile(paths.configFile, "utf8");
        const finalConfig = parseConfig(serialized);
        const expectedEnabled = decision === "replace";
        expect(readTestConfigEntry(finalConfig, "plugins", "holycodex@holycodex")).toEqual(
          decision === "keep" ? keptPluginConfig : { enabled: expectedEnabled },
        );
        expect(
          readTestConfigEntry(finalConfig, "plugins", "build-web-apps@openai-curated"),
        ).toEqual(decision === "keep" ? keptPluginConfig : { enabled: expectedEnabled });
        expect(readTestConfigEntry(finalConfig, "marketplaces", "holycodex")).toEqual(
          decision === "replace"
            ? {
                source_type: "git",
                source: "https://github.com/davidbasilefilho/holycodex.git",
              }
            : {
                source_type: "git",
                source: "https://example.test/custom-holycodex.git",
              },
        );
        expect(serialized).toContain(
          decision === "replace"
            ? "https://github.com/davidbasilefilho/holycodex.git"
            : "https://example.test/custom-holycodex.git",
        );

        const pluginConfig = result.record.plugin_config;
        const providerConfig = result.record.provider_config?.find(
          (entry) => entry.plugin_id === "build-web-apps@openai-curated",
        );
        if (pluginConfig === undefined || providerConfig === undefined) {
          throw new Error("The persisted plugin/provider config snapshots are missing.");
        }
        expect(pluginConfig.before.preference.safe_value).toBeUndefined();
        expect(pluginConfig.after.preference.safe_value).toEqual(
          decision === "replace" ? { kind: "boolean", value: true } : undefined,
        );
        if (decision === "keep") {
          expect(pluginConfig.before.marketplace.digest).toBe(
            pluginConfig.after.marketplace.digest,
          );
        } else {
          expect(pluginConfig.before.marketplace.digest).not.toBe(
            pluginConfig.after.marketplace.digest,
          );
        }
        expect(providerConfig.before.safe_value).toBeUndefined();
        expect(providerConfig.after.safe_value).toEqual(
          decision === "replace" ? { kind: "boolean", value: true } : undefined,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("rejects keeping disabled config for selected plugins", async () => {
    for (const target of ["holycodex", "provider"] as const) {
      const root = await mkdtemp(join(tmpdir(), `holycodex-preflight-disabled-keep-${target}-`));
      const codexHome = join(root, "codex");
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const events: string[] = [];
      const request: InstallRequest = { optional: {} };
      try {
        const manager = configWritingManager(paths, events);
        const runtime = testRuntime(codexHome);
        const baseline = await installHolyCodex(request, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
        });
        if (target === "provider") {
          await writeTestConfigValue(paths, 'plugins."holycodex@holycodex"', {
            enabled: true,
            user_setting: "preserve",
          });
          await writeTestConfigValue(paths, 'plugins."build-web-apps@openai-curated"', {
            enabled: false,
          });
        } else {
          await writeTestConfigValue(paths, 'plugins."holycodex@holycodex"', {
            enabled: false,
          });
        }
        const beforeAttemptEvents = [...events];

        await expect(
          installHolyCodex(request, {
            paths: { codexHome },
            officialPluginManager: manager,
            runtime,
            resolveConflicts: async (conflicts) =>
              Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "keep"])),
          }),
        ).rejects.toMatchObject({ code: "confirmation_required" });

        expect(await readActiveInstallRecord(paths)).toEqual(baseline.record);
        expect(events).toEqual(beforeAttemptEvents);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
