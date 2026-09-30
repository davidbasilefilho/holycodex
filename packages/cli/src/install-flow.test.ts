// SPDX-License-Identifier: Apache-2.0

import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTomlPath, summarizeManagedConfigValue } from "@holycodex/codex";
import { resolveCanonicalVersion } from "@holycodex/core";

import {
  executeCommand,
  installHolyCodex,
  installRecordDigest,
  doctorHolyCodex,
  removeHolyCodex,
  readActiveInstallRecord,
  readInstallationVersion,
  resolveInstallerPaths,
  rootDeveloperInstructions,
  runCli,
  upgradeHolyCodex,
} from "./index.ts";
import { parseConfig } from "./installer.ts";

const CURRENT_VERSION = await readInstallationVersion();
const [CURRENT_MAJOR, CURRENT_MINOR, CURRENT_PATCH] = CURRENT_VERSION.split("-", 1)[0]!.split(".");
const LEGACY_VERSION = `${CURRENT_MAJOR}.${CURRENT_MINOR}.${Number(CURRENT_PATCH) - 1}`;
const PRE_ROUTE_MIGRATION_VERSION = `${CURRENT_MAJOR}.${CURRENT_MINOR}.${Number(CURRENT_PATCH) - 2}`;
import type {
  InstallRequest,
  InstallerOptions,
  InstallerRuntime,
  CliIo,
  OfficialPluginManager,
  ParsedCommand,
} from "./index.ts";
import type { InstallReview } from "./types.ts";

const fakeEnvironment = { PATH: "/fake/bin" } as const;
const additionalPlugin = "sample@openai-curated";
const toolingStates = new Map<string, { installed: boolean }>();

function testRuntime(codexHome: string): InstallerRuntime {
  const state = toolingStates.get(codexHome) ?? { installed: false };
  toolingStates.set(codexHome, state);
  const binRoot = "/fake/bin";
  const projectRoot = "/fake/install/global";
  const packageRoot = "/fake/install/global/node_modules/ctx7";
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
      if (executable === "bun" && args[0] === "add" && args.includes("ctx7@latest")) {
        state.installed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (executable === "bun" && args[0] === "remove" && args.at(-1) === "ctx7") {
        state.installed = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (normalizedCommand === `${shim} --version` && state.installed)
        return { exitCode: 0, stdout: "ctx7 2.0.0\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "missing" };
    },
  };
}

function fakeManager(
  options: Readonly<{
    readonly initial?: Readonly<Record<string, "installed" | "disabled" | "available">>;
    readonly onAdd?: (pluginId: string) => Promise<void>;
    readonly onRemove?: (pluginId: string) => Promise<void>;
  }> = {},
): OfficialPluginManager {
  const states = new Map<string, { installed: boolean; enabled: boolean }>();
  for (const [pluginId, status] of Object.entries(options.initial ?? {})) {
    states.set(pluginId, { installed: status !== "available", enabled: status === "installed" });
  }
  return {
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
      await options.onAdd?.(pluginId);
      states.set(pluginId, { installed: true, enabled: true });
    },
    remove: async (pluginId) => {
      await options.onRemove?.(pluginId);
      states.delete(pluginId);
    },
    status: async (ids) =>
      Object.fromEntries(
        ids.map((id) => {
          const state = states.get(id);
          return [id, state?.installed ? (state.enabled ? "installed" : "disabled") : "missing"];
        }),
      ),
  };
}

function installerOptions(codexHome: string, manager: OfficialPluginManager): InstallerOptions {
  return {
    paths: { codexHome },
    officialPluginManager: manager,
    runtime: testRuntime(codexHome),
  };
}

async function seedInstall(root: string, request: InstallRequest, manager: OfficialPluginManager) {
  const codexHome = join(root, "codex");
  const result = await installHolyCodex(
    request,
    installerOptions(codexHome, manager),
    fakeEnvironment,
  );
  return { codexHome, result };
}

async function makeLegacy(codexHome: string, version = LEGACY_VERSION): Promise<void> {
  const paths = resolveInstallerPaths({ paths: { codexHome } });
  const current = await readActiveInstallRecord(paths);
  if (current === undefined) throw new Error("the seed installation has no active record");
  const legacy = { ...current, version };
  const digest = await installRecordDigest({
    owner: legacy.owner,
    install_id: legacy.install_id,
    version: legacy.version,
    profile: legacy.profile,
    tier: legacy.tier,
    optional_selections: legacy.optional_selections,
    explicit_optional_selections: legacy.explicit_optional_selections,
    official_plugins: legacy.official_plugins ?? [],
    capability_state: legacy.capability_state ?? null,
    managed_artifacts: legacy.managed_artifacts,
    managed_config: legacy.managed_config,
    plugin_config: legacy.plugin_config,
    provider_config: legacy.provider_config,
    plugin_snapshot: legacy.plugin_snapshot,
    owned_plugins: legacy.owned_plugins,
    tooling: legacy.tooling,
  });
  await writeFile(paths.activeRecord, `${JSON.stringify({ ...legacy, digest })}\n`);
  await rm(paths.installOptions, { force: true });
}

async function setLegacyRootModel(
  codexHome: string,
  model: string,
  version = PRE_ROUTE_MIGRATION_VERSION,
): Promise<void> {
  const paths = resolveInstallerPaths({ paths: { codexHome } });
  const current = await readActiveInstallRecord(paths);
  if (current?.managed_config === undefined) throw new Error("the seed has no managed config");
  const managed = current.managed_config.managed;
  const modelEntry = managed["model"];
  if (modelEntry === undefined) throw new Error("the seed does not manage the root model");
  const managedConfig = {
    ...current.managed_config,
    managed: {
      ...managed,
      model: { ...modelEntry, lastManagedValue: await summarizeManagedConfigValue("model", model) },
    },
  };
  const legacy = {
    ...current,
    version,
    managed_config: managedConfig,
  };
  const digest = await installRecordDigest({
    owner: legacy.owner,
    install_id: legacy.install_id,
    version: legacy.version,
    profile: legacy.profile,
    tier: legacy.tier,
    optional_selections: legacy.optional_selections,
    explicit_optional_selections: legacy.explicit_optional_selections,
    official_plugins: legacy.official_plugins ?? [],
    capability_state: legacy.capability_state ?? null,
    managed_artifacts: legacy.managed_artifacts,
    managed_config: legacy.managed_config,
    plugin_config: legacy.plugin_config,
    provider_config: legacy.provider_config,
    plugin_snapshot: legacy.plugin_snapshot,
    owned_plugins: legacy.owned_plugins,
    tooling: legacy.tooling,
  });
  await writeFile(paths.activeRecord, `${JSON.stringify({ ...legacy, digest })}\n`);
  const config = await readFile(paths.configFile, "utf8");
  await writeFile(
    paths.configFile,
    config.replace(/model = "[^"]+"/u, `model = ${JSON.stringify(model)}`),
  );
}

function commandContext(codexHome: string, manager: OfficialPluginManager, io: CliIo) {
  return {
    env: fakeEnvironment,
    io,
    installer: installerOptions(codexHome, manager),
  };
}

describe("command install and upgrade review flow", () => {
  test("installer debug mode does not persist configuration diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-debug-log-"));
    const codexHome = join(root, "codex");
    try {
      await installHolyCodex(
        { profile: "default", optional: { computer_use: false } },
        installerOptions(codexHome, fakeManager()),
        { ...fakeEnvironment, HOLYCODEX_DEBUG_INSTALLER: "1" },
      );
      const debugLog = await readFile(join(codexHome, ".holycodex-debug.log"), "utf8").catch(
        () => undefined,
      );
      expect(debugLog).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("upgrades legacy canonical Root routes and preserves recorded user overrides", async () => {
    for (const profile of ["low", "default"] as const) {
      const root = await mkdtemp(join(tmpdir(), `holycodex-cli-flow-root-route-${profile}-`));
      const codexHome = join(root, "codex");
      const manager = fakeManager();
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      try {
        await seedInstall(root, { profile, optional: { computer_use: false } }, manager);
        await setLegacyRootModel(codexHome, "gpt-6-astra");
        await installHolyCodex(
          { optional: { computer_use: false } },
          {
            ...installerOptions(codexHome, manager),
            reviewInstall: async () => ({ action: "apply" }),
          },
          fakeEnvironment,
        );
        expect(await readFile(paths.configFile, "utf8")).toContain('model = "gpt-6.1-sol"');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-root-override-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    try {
      await seedInstall(root, { profile: "low", optional: { computer_use: false } }, manager);
      await setLegacyRootModel(codexHome, "gpt-5.6-terra");
      await installHolyCodex(
        { optional: { computer_use: false } },
        {
          ...installerOptions(codexHome, manager),
          reviewInstall: async () => ({ action: "apply" }),
        },
        fakeEnvironment,
      );
      expect(await readFile(paths.configFile, "utf8")).toContain('model = "gpt-5.6-terra"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("migrates boundary-version managed Root routes while replacing an edited value with --yes warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-root-boundary-migration-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const manager = fakeManager();
    const stderr: string[] = [];
    try {
      await seedInstall(
        root,
        { profile: "high", tier: "fast-all", optional: { computer_use: false } },
        manager,
      );
      await setLegacyRootModel(codexHome, "gpt-6-astra", LEGACY_VERSION);

      const migrated = await upgradeHolyCodex(
        installerOptions(codexHome, manager),
        fakeEnvironment,
      );
      expect(migrated.status).toBe("upgraded");
      expect(parseConfig(await readFile(paths.configFile, "utf8"))).toMatchObject({
        model: "gpt-6.1-sol",
        model_reasoning_effort: "high",
      });

      await setLegacyRootModel(codexHome, "gpt-6-astra", LEGACY_VERSION);
      await writeFile(
        paths.configFile,
        (await readFile(paths.configFile, "utf8")).replace(
          'model = "gpt-6-astra"',
          'model = "gpt-5.6-terra"',
        ),
      );
      const replaced = await runCli(["install", "--yes", "--json", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io: {
          stdoutIsTTY: false,
          stderrIsTTY: false,
          writeStderr: (text) => stderr.push(text),
        },
        installer: installerOptions(codexHome, manager),
      });
      expect(replaced.exitCode).toBe(0);
      expect(stderr.join("")).toContain("Warning: --yes will apply these conflict decisions");
      expect(stderr.join("")).toContain("replace");
      expect(parseConfig(await readFile(paths.configFile, "utf8"))).toMatchObject({
        model: "gpt-6.1-sol",
        model_reasoning_effort: "high",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps recovery state when rollback cannot remove newly installed Context7", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-context7-rollback-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const baseRuntime = testRuntime(codexHome);
    const manager = fakeManager();
    const failingManager: OfficialPluginManager = {
      ...manager,
      addMarketplace: async () => {
        throw new Error("injected rollback after Context7 installation");
      },
    };
    const context7RemoveCalls: string[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await expect(
        installHolyCodex(
          { optional: { computer_use: false } },
          {
            ...installerOptions(codexHome, failingManager),
            runtime: {
              ...baseRuntime,
              run: async (executable, args) => {
                if (args[0] === "remove" && args.includes("ctx7")) {
                  context7RemoveCalls.push(`${executable} ${args.join(" ")}`);
                  return { exitCode: 1, stdout: "", stderr: "injected remove failure" };
                }
                return await baseRuntime.run(executable, args);
              },
            },
          },
          fakeEnvironment,
        ),
      ).rejects.toBeDefined();
      expect(context7RemoveCalls).toEqual(["bun remove --global --cwd=/ ctx7"]);
      const recovery = JSON.parse(await readFile(paths.conflictedRecord, "utf8")) as {
        readonly managed_config?: { readonly managed?: Readonly<Record<string, unknown>> };
        readonly tooling?: { readonly context7?: { readonly ownership?: string } };
      };
      expect(recovery.tooling?.context7?.ownership).toBe("holycodex");
      expect(recovery.managed_config?.managed).not.toHaveProperty("model");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("preserves a pre-existing user-owned Context7 package when install rolls back", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-user-context7-rollback-"));
    const codexHome = join(root, "codex");
    const existingContext7 = { installed: true };
    toolingStates.set(codexHome, existingContext7);
    const baseRuntime = testRuntime(codexHome);
    const manager = fakeManager();
    const failingManager: OfficialPluginManager = {
      ...manager,
      addMarketplace: async () => {
        throw new Error("injected rollback after Context7 verification");
      },
    };
    const context7Mutations: string[] = [];
    try {
      await expect(
        installHolyCodex(
          { optional: { computer_use: false } },
          {
            ...installerOptions(codexHome, failingManager),
            runtime: {
              ...baseRuntime,
              run: async (executable, args) => {
                if (
                  (args[0] === "add" && args[1] === "-g" && args[2] === "ctx7@latest") ||
                  (args[0] === "remove" && args[1] === "-g" && args[2] === "ctx7")
                ) {
                  context7Mutations.push(`${executable} ${args.join(" ")}`);
                }
                return await baseRuntime.run(executable, args);
              },
            },
          },
          fakeEnvironment,
        ),
      ).rejects.toBeDefined();
      expect(context7Mutations).toEqual([]);
      expect(existingContext7.installed).toBe(true);
    } finally {
      toolingStates.delete(codexHome);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("prepublish recovery retains prior ownership for kept managed-config drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-managed-recovery-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const initial = await seedInstall(root, { optional: { computer_use: false } }, fakeManager());
    const config = await readFile(paths.configFile, "utf8");
    const customModel = 'model = "gpt-6-luna"';
    const modelEntry = /^model = .*$/mu.exec(config)?.[0];
    expect(modelEntry).toBeDefined();
    await writeFile(paths.configFile, config.replace(modelEntry!, customModel));

    const manager = fakeManager();
    let failNextReadback = false;
    let readbackFailures = 0;
    let addCalls = 0;
    const interruptedManager: OfficialPluginManager = {
      ...manager,
      list: async () => {
        if (failNextReadback) {
          failNextReadback = false;
          readbackFailures += 1;
          throw new Error("injected plugin readback failure");
        }
        return await manager.list!();
      },
      add: async (pluginId) => {
        addCalls += 1;
        await manager.add!(pluginId);
        if (pluginId === "holycodex@holycodex") failNextReadback = true;
      },
    };

    try {
      await expect(
        installHolyCodex(
          {},
          {
            ...installerOptions(codexHome, interruptedManager),
            resolveConflicts: async (conflicts) =>
              Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "keep"])),
            reviewInstall: async () => ({ action: "apply" }),
          },
          fakeEnvironment,
        ),
      ).rejects.toMatchObject({ code: "capability_denied" });

      expect(addCalls).toBeGreaterThan(0);
      expect(readbackFailures).toBe(1);

      const recovery = JSON.parse(await readFile(paths.conflictedRecord, "utf8")) as {
        readonly managed_config: {
          readonly managed: Readonly<Record<string, { readonly lastManagedValue: unknown }>>;
        };
      };
      expect(recovery.managed_config.managed["model"]?.lastManagedValue).toEqual(
        initial.result.record.managed_config?.managed["model"]?.lastManagedValue,
      );

      await removeHolyCodex(
        {
          ...installerOptions(codexHome, interruptedManager),
          resolveConflict: async () => "decline",
        },
        fakeEnvironment,
      );
      expect(await readFile(paths.configFile, "utf8")).toContain(customModel);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("does not offer keep for a conflicting registered role", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-reopen-conflicts-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    const rendererKeys = [[{ name: "A", shift: true }, { name: "enter" }]] as const;
    let rendererIndex = 0;
    const renderers = rendererKeys.map((keys) => {
      let keypress: ((key: (typeof keys)[number]) => void) | undefined;
      return {
        root: { add: (_value: unknown): void => undefined },
        keyInput: {
          on: (_event: string, listener: (key: (typeof keys)[number]) => void): void => {
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
    });
    class TestStyledText {
      constructor(readonly chunks: readonly { readonly text: string }[]) {}
    }
    class TestTextRenderable {
      constructor(_renderer: unknown, _options: { readonly content: TestStyledText }) {}
    }
    const styled = (text: string) => new TestStyledText([{ text }]);
    await mock.module("@opentui/core", () => ({
      createCliRenderer: async () => renderers[rendererIndex++]!,
      TextRenderable: TestTextRenderable,
      StyledText: TestStyledText,
      stringToStyledText: styled,
      fg: () => styled,
      bold: styled,
      cyan: styled,
      dim: styled,
      green: styled,
      red: styled,
      yellow: styled,
    }));
    try {
      const { codexHome: installedHome } = await seedInstall(
        root,
        { optional: { computer_use: false } },
        manager,
      );
      const paths = resolveInstallerPaths({ paths: { codexHome: installedHome } });
      const activeRecord = await readActiveInstallRecord(paths);
      const roleArtifact = activeRecord?.managed_artifacts.find(({ path }) =>
        path.endsWith("/Worker.implementation.toml"),
      );
      if (roleArtifact === undefined) throw new Error("the implementation role is not managed");
      const rolePath = join(installedHome, roleArtifact.path);
      const originalRole = await readFile(rolePath, "utf8");
      const userRole = originalRole.replace(
        /^description = .+$/mu,
        'description = "keep my reopened conflict choice"',
      );
      if (userRole === originalRole) throw new Error("the managed role description is missing");
      await writeFile(rolePath, userRole);

      const reviews: InstallReview[] = [];
      const reviewActions = ["apply"] as const;
      const result = await runCli(["install", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io: {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          installWizard: async (request) => ({ action: "install", request }),
          installReview: async (review) => {
            reviews.push(review);
            return { action: reviewActions[reviews.length - 1]! };
          },
        },
        installer: installerOptions(codexHome, manager),
      });
      expect(result.exitCode).toBe(0);
      expect(result.envelope).toMatchObject({ ok: true, command: "install" });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.conflicts.find(({ path }) => path === rolePath)?.validDecisions).toEqual([
        "replace",
        "cancel",
      ]);
      expect(
        reviews.map((review) => review.conflicts.find(({ path }) => path === rolePath)?.decision),
      ).toEqual(["replace"]);
      expect(await readFile(rolePath, "utf8")).not.toBe(userRole);
    } finally {
      mock.restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("persists Root instructions selected for each profile model", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-root-model-"));
    try {
      const installedConfigs = new Map<string, Record<string, unknown>>();
      for (const profile of ["high", "low", "default"] as const) {
        const codexHome = join(root, profile);
        await installHolyCodex(
          {
            profile,
            optional: { computer_use: false },
          },
          installerOptions(codexHome, fakeManager()),
          fakeEnvironment,
        );
        installedConfigs.set(
          profile,
          parseConfig(await readFile(join(codexHome, "config.toml"), "utf8")),
        );
      }

      const highConfig = installedConfigs.get("high")!;
      const lowConfig = installedConfigs.get("low")!;
      const defaultConfig = installedConfigs.get("default")!;
      expect(highConfig["model"]).toBe("gpt-6.1-sol");
      expect(lowConfig["model"]).toBe("gpt-6.1-sol");
      expect(defaultConfig["model"]).toBe("gpt-6.1-sol");
      expect(lowConfig["model_reasoning_effort"]).toBe("low");
      expect(defaultConfig["model_reasoning_effort"]).toBe("medium");
      expect(highConfig["model_reasoning_effort"]).toBe("high");

      const highInstructions = highConfig["developer_instructions"] as string;
      const solInstructions = rootDeveloperInstructions({
        browserUse: true,
        frontend: true,
        security: true,
        rootModel: "gpt-6.1-sol",
      });
      expect(highInstructions).toBe(
        rootDeveloperInstructions({
          browserUse: true,
          frontend: true,
          security: true,
          rootModel: "gpt-6.1-sol",
        }),
      );
      expect(highInstructions).toContain("Never perform delegable work yourself");
      expect(highInstructions).toContain("collaboration.wait_agent at timeout_ms=600000");
      expect(highInstructions).toContain("On timeout, inspect only for actionable failures");
      expect(lowConfig["developer_instructions"]).toBe(solInstructions);
      expect(defaultConfig["developer_instructions"]).toBe(solInstructions);
      expect(solInstructions).toBe(highInstructions);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps an explicitly empty parsed plugin selection empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-empty-plugins-"));
    const codexHome = join(root, "codex");
    let initialRequest: InstallRequest | undefined;
    try {
      const parsed: ParsedCommand = {
        command: "install",
        positionals: [],
        options: { "add-plugin": [], "codex-home": codexHome },
      };
      const result = await executeCommand(
        parsed,
        commandContext(codexHome, fakeManager(), {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          installWizard: async (current) => {
            initialRequest = current;
            return { action: "cancel" };
          },
        }),
      );
      expect(initialRequest).toEqual({ officialPlugins: [] });
      expect(result).toEqual({ cancelled: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preloads saved selections in the interactive install wizard and applies flag overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-saved-options-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager({ initial: { [additionalPlugin]: "available" } });
    try {
      await seedInstall(
        root,
        {
          profile: "high",
          tier: "fast",
          optional: { computer_use: true, sites: false },
          officialPlugins: [additionalPlugin],
        },
        manager,
      );
      let initialRequest: InstallRequest | undefined;
      const result = await runCli(
        ["install", "--profile", "low", "--sites", "--codex-home", codexHome],
        commandContext(codexHome, manager, {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          installWizard: async (current) => {
            initialRequest = current;
            return { action: "cancel" };
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(initialRequest).toMatchObject({
        profile: "low",
        tier: "fast",
        optional: { computer_use: true, sites: true },
        officialPlugins: [additionalPlugin],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("preloads the active record when saved install options are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-active-options-"));
    const manager = fakeManager({ initial: { [additionalPlugin]: "available" } });
    try {
      const { codexHome } = await seedInstall(
        root,
        {
          profile: "high",
          tier: "fast",
          optional: { browser_use: true, computer_use: false, sites: true },
          officialPlugins: [additionalPlugin],
        },
        manager,
      );
      await rm(resolveInstallerPaths({ paths: { codexHome } }).installOptions);
      let initialRequest: InstallRequest | undefined;
      await runCli(
        ["install", "--codex-home", codexHome],
        commandContext(codexHome, manager, {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          installWizard: async (current) => {
            initialRequest = current;
            return { action: "cancel" };
          },
        }),
      );
      expect(initialRequest).toMatchObject({
        profile: "high",
        tier: "fast",
        optional: { browser_use: true, computer_use: false, sites: true },
        officialPlugins: expect.arrayContaining([
          "build-web-apps@openai-curated",
          "codex-security@openai-curated",
          additionalPlugin,
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects unknown final review actions before writing installation state", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-review-action-"));
    const codexHome = join(root, "codex");
    try {
      await expect(
        installHolyCodex(
          { optional: { computer_use: false } },
          {
            ...installerOptions(codexHome, fakeManager()),
            reviewInstall: async () => ({ action: "unexpected" }) as never,
          },
          fakeEnvironment,
        ),
      ).rejects.toMatchObject({ code: "confirmation_required" });
      expect(await readActiveInstallRecord(resolveInstallerPaths({ paths: { codexHome } }))).toBe(
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects edits to initially canonical plugin config after review", async () => {
    for (const changedEntry of [
      '[plugins."holycodex@holycodex"]\nenabled = false\n',
      `[plugins."${additionalPlugin}"]\nenabled = false\n`,
      '[marketplaces.holycodex]\nsource_type = "git"\nsource = "https://example.com/changed.git"\n',
    ]) {
      const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-plugin-drift-"));
      const codexHome = join(root, "codex");
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      try {
        await mkdir(codexHome, { recursive: true });
        await expect(
          installHolyCodex(
            {
              optional: { computer_use: false },
              officialPlugins: [additionalPlugin],
            },
            {
              ...installerOptions(codexHome, fakeManager()),
              reviewInstall: async () => {
                const current = await readFile(paths.configFile, "utf8").catch(() => "");
                await writeFile(paths.configFile, `${current}\n${changedEntry}`);
                return { action: "apply" };
              },
            },
            fakeEnvironment,
          ),
        ).rejects.toMatchObject({ code: "confirmation_required" });
        expect(await readActiveInstallRecord(paths)).toBe(undefined);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("cannot keep disabled config for a selected provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-disabled-provider-"));
    const manager = fakeManager({ initial: { [additionalPlugin]: "available" } });
    try {
      await mkdir(join(root, "codex"), { recursive: true });
      await writeFile(
        join(root, "codex", "config.toml"),
        `[plugins."${additionalPlugin}"]\nenabled = true\n`,
      );
      const { codexHome } = await seedInstall(
        root,
        {
          optional: { computer_use: false },
          officialPlugins: [additionalPlugin],
        },
        manager,
      );
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const current = await readFile(paths.configFile, "utf8");
      const marker = `[plugins."${additionalPlugin}"]\nenabled = true`;
      expect(current).toContain(marker);
      await writeFile(paths.configFile, current.replace(marker, marker.replace("true", "false")));
      await expect(
        installHolyCodex(
          {},
          {
            ...installerOptions(codexHome, manager),
            resolveConflicts: async (conflicts) =>
              Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "keep"])),
            reviewInstall: async () => ({ action: "apply" }),
          },
          fakeEnvironment,
        ),
      ).rejects.toMatchObject({ code: "confirmation_required" });
      expect(await readFile(paths.configFile, "utf8")).toContain(marker.replace("true", "false"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects a reviewed canonical provider entry changed before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-reviewed-provider-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager({ initial: { [additionalPlugin]: "available" } });
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, "config.toml"),
        `[plugins."${additionalPlugin}"]\nenabled = true\n`,
      );
      await installHolyCodex(
        {
          optional: { computer_use: false },
          officialPlugins: [additionalPlugin],
        },
        installerOptions(codexHome, manager),
        fakeEnvironment,
      );
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const before = await readFile(paths.activeRecord, "utf8");
      await expect(
        installHolyCodex(
          {},
          {
            ...installerOptions(codexHome, manager),
            reviewInstall: async () => {
              const current = await readFile(paths.configFile, "utf8");
              const marker = `[plugins."${additionalPlugin}"]\nenabled = true`;
              expect(current).toContain(marker);
              await writeFile(
                paths.configFile,
                current.replace(marker, marker.replace("true", "false")),
              );
              return { action: "apply" };
            },
          },
          fakeEnvironment,
        ),
      ).rejects.toMatchObject({ code: "confirmation_required" });
      expect(await readFile(paths.activeRecord, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("removes deselected provider-backed plugins and preserves host-managed Browser state", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-deselect-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const foreignPlugin = "foreign-plugin@openai-curated";
    const manager = fakeManager({
      initial: {
        [additionalPlugin]: "available",
        [foreignPlugin]: "installed",
        "browser@openai-bundled": "installed",
      },
    });
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        paths.configFile,
        '[plugins."browser@openai-bundled"]\nenabled = true\nuser_setting = "keep"\n',
      );
      const initial = await installHolyCodex(
        {
          optional: { computer_use: false },
          officialPlugins: [additionalPlugin],
        },
        installerOptions(codexHome, manager),
        fakeEnvironment,
      );
      expect(initial.record.owned_plugins).toEqual(
        expect.arrayContaining([
          "holycodex@holycodex",
          "build-web-apps@openai-curated",
          additionalPlugin,
        ]),
      );
      const initialConfig = parseConfig(await readFile(paths.configFile, "utf8"));
      const initialAgentRef = readTomlPath(initialConfig, 'agents."Explorer.map".config_file');
      await writeFile(
        paths.configFile,
        `${await readFile(paths.configFile, "utf8")}\n[plugins."${foreignPlugin}"]\nenabled = false\nsource = "external"\n`,
      );

      const reconciled = await installHolyCodex(
        {
          optional: { browser_use: false, computer_use: false, sites: false },
          officialPlugins: [],
        },
        installerOptions(codexHome, manager),
        fakeEnvironment,
      );

      expect(reconciled.record.official_plugins).not.toContain(additionalPlugin);
      expect(reconciled.record.owned_plugins).toEqual(
        expect.arrayContaining([
          "holycodex@holycodex",
          "build-web-apps@openai-curated",
          "codex-security@openai-curated",
        ]),
      );
      expect(await manager.list!()).toMatchObject({
        installed: expect.arrayContaining([
          expect.objectContaining({
            pluginId: "holycodex@holycodex",
            installed: true,
            enabled: true,
          }),
          expect.objectContaining({
            pluginId: foreignPlugin,
            installed: true,
            enabled: true,
          }),
        ]),
      });
      expect((await manager.list!()).installed).toContainEqual(
        expect.objectContaining({
          pluginId: "browser@openai-bundled",
          installed: true,
          enabled: true,
        }),
      );
      expect((await manager.list!()).installed.map((entry) => entry.pluginId)).not.toContain(
        "sites@openai-bundled",
      );
      const publishedConfig = parseConfig(await readFile(paths.configFile, "utf8"));
      expect(readTomlPath(publishedConfig, 'plugins."browser@openai-bundled".enabled')).toBe(true);
      expect(readTomlPath(publishedConfig, 'plugins."browser@openai-bundled".user_setting')).toBe(
        "keep",
      );
      const publishedAgentRef = readTomlPath(publishedConfig, 'agents."Explorer.map".config_file');
      expect(publishedAgentRef).not.toBe(initialAgentRef);
      expect(typeof publishedAgentRef).toBe("string");
      await expect(
        readFile(join(codexHome, publishedAgentRef as string), "utf8"),
      ).resolves.toBeTruthy();
      expect((await manager.list!()).installed.map((entry) => entry.pluginId)).not.toContain(
        additionalPlugin,
      );
      const config = await readFile(paths.configFile, "utf8");
      expect(config).toContain(`[plugins."${foreignPlugin}"]`);
      expect(config).toContain('source = "external"');
      expect(config).toContain("enabled = false");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("reconciles same-base development and stable release identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-release-channel-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    const currentBase = CURRENT_VERSION.split("-", 1)[0]!;
    const developmentVersion = `${currentBase}-dev.1.1`;
    let targetVersion = developmentVersion;
    try {
      const { result } = await seedInstall(root, {}, manager);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      await mock.module("./manifest.ts", () => ({
        readInstallationVersion: async () => targetVersion,
      }));
      try {
        const maintenanceModulePath: string = "./maintenance.ts?development-release-upgrade";
        const maintenance = (await import(
          maintenanceModulePath
        )) as typeof import("./maintenance.ts");
        const developmentDryRun = await maintenance.upgradeHolyCodex(
          installerOptions(codexHome, manager),
          fakeEnvironment,
          { dryRun: true },
        );
        expect(developmentDryRun.status).toBe("dry_run");
        expect(developmentDryRun.from_version).toBe(CURRENT_VERSION);
        expect(developmentDryRun.to_version).toBe(developmentVersion);
        expect(developmentDryRun.changes).toContain("version");

        const developmentRecord = { ...result.record, version: developmentVersion };
        developmentRecord.digest = await installRecordDigest({
          owner: developmentRecord.owner,
          install_id: developmentRecord.install_id,
          version: developmentRecord.version,
          profile: developmentRecord.profile,
          tier: developmentRecord.tier,
          optional_selections: developmentRecord.optional_selections,
          explicit_optional_selections: developmentRecord.explicit_optional_selections,
          official_plugins: developmentRecord.official_plugins ?? [],
          capability_state: developmentRecord.capability_state ?? null,
          managed_artifacts: developmentRecord.managed_artifacts,
          managed_config: developmentRecord.managed_config,
          plugin_config: developmentRecord.plugin_config,
          provider_config: developmentRecord.provider_config,
          plugin_snapshot: developmentRecord.plugin_snapshot,
          owned_plugins: developmentRecord.owned_plugins,
          tooling: developmentRecord.tooling,
        });
        await writeFile(paths.activeRecord, `${JSON.stringify(developmentRecord)}\n`);

        targetVersion = CURRENT_VERSION;
        const stableUpgrade = await maintenance.upgradeHolyCodex(
          installerOptions(codexHome, manager),
          fakeEnvironment,
        );
        expect(stableUpgrade.status).toBe("upgraded");
        expect(stableUpgrade.from_version).toBe(developmentVersion);
        expect(stableUpgrade.to_version).toBe(CURRENT_VERSION);
        expect(stableUpgrade.changes).toContain("version");
        expect(stableUpgrade.record?.version).toBe(CURRENT_VERSION);

        const futureInstallerModule: string = "./installer.ts?route-update-boundary";
        const futureInstaller = (await import(
          futureInstallerModule
        )) as typeof import("./installer.ts");
        targetVersion = CURRENT_VERSION;
        const routeRoot = join(root, "route-update");
        const routeCodexHome = join(routeRoot, "codex");
        await mkdir(routeRoot, { recursive: true });
        const routePaths = resolveInstallerPaths({ paths: { codexHome: routeCodexHome } });
        await futureInstaller.installHolyCodex(
          {
            profile: "low",
            optional: { computer_use: false },
          },
          installerOptions(routeCodexHome, manager),
          fakeEnvironment,
        );

        targetVersion = resolveCanonicalVersion("patch", CURRENT_VERSION);
        await futureInstaller.installHolyCodex(
          {
            profile: "high",
            optional: { computer_use: false },
          },
          {
            ...installerOptions(routeCodexHome, manager),
            reviewInstall: async () => ({ action: "apply" }),
          },
          fakeEnvironment,
        );
        expect(parseConfig(await readFile(routePaths.configFile, "utf8"))["model"]).toBe(
          "gpt-6.1-sol",
        );
      } finally {
        mock.restore();
      }
    } finally {
      mock.restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps JSON and non-TTY mutations out of the review UI while --yes applies", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-gates-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    try {
      const noTty = await runCli(["install", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io: { stdoutIsTTY: false, stderrIsTTY: false },
        installer: installerOptions(codexHome, manager),
      });
      expect(noTty.envelope).toMatchObject({
        ok: false,
        error: { code: "non_tty_confirmation_required" },
      });
      expect(await readActiveInstallRecord(resolveInstallerPaths({ paths: { codexHome } }))).toBe(
        undefined,
      );

      const json = await runCli(["install", "--yes", "--json", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io: { stdoutIsTTY: false, stderrIsTTY: false },
        installer: installerOptions(codexHome, manager),
      });
      expect(json.exitCode).toBe(0);
      expect(json.envelope).toMatchObject({ ok: true, command: "install" });
      expect(
        await readActiveInstallRecord(resolveInstallerPaths({ paths: { codexHome } })),
      ).toEqual(expect.objectContaining({ status: "active" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("lets --yes replace conflicting managed configuration and warns before overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-yes-conflict-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const manager = fakeManager();
    const stderr: string[] = [];
    try {
      await seedInstall(root, {}, manager);
      await writeFile(
        paths.configFile,
        (await readFile(paths.configFile, "utf8")).replace(
          'model = "gpt-6.1-sol"',
          'model = "user-model"',
        ),
      );
      const result = await runCli(["install", "--yes", "--json", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io: {
          stdoutIsTTY: false,
          stderrIsTTY: false,
          writeStderr: (text) => stderr.push(text),
        },
        installer: installerOptions(codexHome, manager),
      });
      expect(result.exitCode).toBe(0);
      expect(result.envelope).toMatchObject({ ok: true, command: "install" });
      expect(stderr.join("")).toContain("Warning: --yes will apply these conflict decisions");
      expect(stderr.join("")).toContain("replace");
      expect(await readFile(paths.configFile, "utf8")).toContain('model = "gpt-6.1-sol"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("reconstructs legacy selections for internal migration review", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-upgrade-keep-"));
    const manager = fakeManager({ initial: { [additionalPlugin]: "available" } });
    try {
      const { codexHome } = await seedInstall(
        root,
        {
          profile: "high",
          tier: "fast",
          optional: { browser_use: true, computer_use: false, sites: true },
          officialPlugins: [additionalPlugin],
        },
        manager,
      );
      await makeLegacy(codexHome);
      let reviewRequest: InstallRequest | undefined;
      const result = await upgradeHolyCodex(
        {
          ...installerOptions(codexHome, manager),
          reviewInstall: async (review) => {
            reviewRequest = {
              profile: review.profile,
              tier: review.tier,
              optional: review.capabilities,
              officialPlugins: review.additionalPlugins,
            };
            return { action: "apply" };
          },
        },
        fakeEnvironment,
      );
      expect(result.status).toBe("upgraded");
      expect(reviewRequest).toEqual({
        profile: "high",
        tier: "fast",
        optional: { browser_use: true, computer_use: false, sites: true },
        officialPlugins: [additionalPlugin],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("restores kept managed settings after an upgrade health reinstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-kept-health-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    let rewriteOnAdd = false;
    const manager = fakeManager({
      onAdd: async (pluginId) => {
        if (rewriteOnAdd && pluginId === "holycodex@holycodex") {
          const current = await readFile(paths.configFile, "utf8");
          await writeFile(
            paths.configFile,
            current.replace('model = "gpt-5.6-terra"', 'model = "gpt-6-health"'),
          );
        }
      },
    });
    try {
      await seedInstall(root, { optional: { computer_use: false } }, manager);
      await makeLegacy(codexHome);
      await writeFile(
        paths.configFile,
        (await readFile(paths.configFile, "utf8"))
          .replace('model = "gpt-6.1-sol"', 'model = "gpt-5.6-terra"')
          .replace("experimental_mode = true", 'experimental_mode = false\nunrelated = "keep"'),
      );
      rewriteOnAdd = true;

      await installHolyCodex(
        { optional: { computer_use: false } },
        {
          ...installerOptions(codexHome, manager),
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(
              conflicts.map((conflict) => [
                conflict.identity!,
                conflict.key === "features.context_management.experimental_mode"
                  ? "replace"
                  : "keep",
              ]),
            ),
          reviewInstall: async () => ({ action: "apply" }),
        },
        fakeEnvironment,
      );

      const finalConfig = await readFile(paths.configFile, "utf8");
      expect(finalConfig).toContain('model = "gpt-5.6-terra"');
      expect(finalConfig).toContain("experimental_mode = true");
      expect(finalConfig).toContain('unrelated = "keep"');

      await manager.remove?.("holycodex@holycodex");
      await installHolyCodex(
        { optional: { computer_use: false } },
        {
          ...installerOptions(codexHome, manager),
          reviewInstall: async () => ({ action: "apply" }),
        },
        fakeEnvironment,
      );
      const reinstalledConfig = await readFile(paths.configFile, "utf8");
      expect(reinstalledConfig).toContain('model = "gpt-5.6-terra"');
      expect(reinstalledConfig).toContain("experimental_mode = true");
      expect(reinstalledConfig).toContain('unrelated = "keep"');
      expect(
        (
          await doctorHolyCodex({
            paths: { codexHome },
            officialPluginManager: manager,
            runtime: testRuntime(codexHome),
          })
        ).healthy,
      ).toBe(true);

      await writeFile(paths.configFile, reinstalledConfig.replace('model = "gpt-5.6-terra"\n', ""));
      await installHolyCodex(
        { optional: { computer_use: false } },
        {
          ...installerOptions(codexHome, manager),
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(conflicts.map((conflict) => [conflict.identity!, "keep"])),
          reviewInstall: async () => ({ action: "apply" }),
        },
        fakeEnvironment,
      );
      const missingConfig = await readFile(paths.configFile, "utf8");
      expect(missingConfig).not.toContain("model = ");
      expect(
        (await readActiveInstallRecord(paths))?.managed_config?.managed["model"],
      ).toBeUndefined();
      const missingDoctor = await doctorHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime: testRuntime(codexHome),
      });
      expect(missingDoctor.healthy).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("reviews explicit internal migration options", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-upgrade-change-"));
    const manager = fakeManager({ initial: { [additionalPlugin]: "available" } });
    try {
      const { codexHome } = await seedInstall(
        root,
        {
          profile: "high",
          tier: "fast",
          optional: { computer_use: false },
          officialPlugins: [additionalPlugin],
        },
        manager,
      );
      await makeLegacy(codexHome);
      const selected: InstallRequest = {
        profile: "low",
        tier: "standard",
        optional: { browser_use: true, computer_use: false, sites: true },
        officialPlugins: [additionalPlugin],
      };
      let reviewRequest: InstallRequest | undefined;
      const result = await upgradeHolyCodex(
        {
          ...installerOptions(codexHome, manager),
          reviewInstall: async (review) => {
            reviewRequest = {
              profile: review.profile,
              tier: review.tier,
              optional: review.capabilities,
              officialPlugins: review.additionalPlugins,
            };
            return { action: "apply" };
          },
        },
        fakeEnvironment,
        { options: selected },
      );
      expect(result.status).toBe("upgraded");
      expect(reviewRequest).toEqual(selected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("lets final install review Change options retain the reviewed selections", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-install-change-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager({ initial: { [additionalPlugin]: "available" } });
    try {
      let wizardCalls = 0;
      const reviewed: InstallRequest[] = [];
      const reviewActions: string[] = [];
      const result = await runCli(
        [
          "install",
          "--profile",
          "high",
          "--tier",
          "fast",
          "--no-sites",
          "--add-plugin",
          additionalPlugin,
          "--codex-home",
          codexHome,
        ],
        commandContext(codexHome, manager, {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          installWizard: async (current) => {
            wizardCalls += 1;
            reviewed.push(current);
            return wizardCalls === 1
              ? { action: "install", request: current }
              : {
                  action: "install",
                  request: {
                    profile: "low",
                    tier: "standard",
                    optional: { browser_use: true, computer_use: false, sites: false },
                    officialPlugins: [additionalPlugin],
                  },
                };
          },
          installReview: async (review) => {
            reviewActions.push(reviewOperation(review));
            return reviewActions.length === 1 ? { action: "change" } : { action: "apply" };
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(wizardCalls).toBe(2);
      expect(reviewed).toEqual([
        {
          profile: "high",
          tier: "fast",
          optional: { sites: false },
          officialPlugins: [additionalPlugin],
        },
        {
          profile: "high",
          tier: "fast",
          optional: { browser_use: true, computer_use: false, sites: false },
          officialPlugins: [additionalPlugin],
        },
      ]);
      expect(reviewActions).toEqual(["install", "install"]);
      expect(
        await readActiveInstallRecord(resolveInstallerPaths({ paths: { codexHome } })),
      ).toEqual(expect.objectContaining({ profile: "low", tier: "standard" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function reviewOperation(review: { readonly operation: string }): string {
  return review.operation;
}
