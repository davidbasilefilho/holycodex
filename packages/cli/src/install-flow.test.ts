// SPDX-License-Identifier: Apache-2.0

import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeCommand,
  installHolyCodex,
  installRecordDigest,
  doctorHolyCodex,
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
      if (command === "bun add -g ctx7@latest") {
        state.installed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "bun remove -g ctx7") {
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

function commandContext(codexHome: string, manager: OfficialPluginManager, io: CliIo) {
  return {
    env: fakeEnvironment,
    io,
    installer: installerOptions(codexHome, manager),
  };
}

describe("command install and upgrade review flow", () => {
  test("preserves conflict choices when the final review reopens resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-reopen-conflicts-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    const rendererKeys = [
      [{ name: "K", shift: true }, { name: "enter" }],
      [{ name: "A", shift: true }, { name: "escape" }],
      [{ name: "enter" }],
    ] as const;
    const rendererScreens: string[] = [];
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
      constructor(_renderer: unknown, options: { readonly content: TestStyledText }) {
        rendererScreens.push(options.content.chunks.map(({ text }) => text).join(""));
      }
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
        { optional: { frontend: false, security: false, computer_use: false } },
        manager,
      );
      const paths = resolveInstallerPaths({ paths: { codexHome: installedHome } });
      const rolePath = join(paths.roleRoot, "Worker.implementation.toml");
      const userRole = "keep my reopened conflict choice\n";
      await writeFile(rolePath, userRole);

      const reviews: InstallReview[] = [];
      const reviewActions = ["resolve", "resolve", "apply"] as const;
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
      expect(reviews).toHaveLength(3);
      expect(
        reviews.map((review) => review.conflicts.find(({ path }) => path === rolePath)?.decision),
      ).toEqual(["keep", "keep", "keep"]);
      expect(rendererScreens[1]).toContain("decision: keep");
      expect(rendererScreens[2]).toContain("decision: keep");
      expect(await readFile(rolePath, "utf8")).toBe(userRole);
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
            optional: { frontend: true, security: true, computer_use: false },
          },
          installerOptions(codexHome, fakeManager()),
          fakeEnvironment,
        );
        installedConfigs.set(
          profile,
          parseConfig(await readFile(join(codexHome, "config.toml"), "utf8")),
        );
      }

      const astraConfig = installedConfigs.get("high")!;
      const lowConfig = installedConfigs.get("low")!;
      const defaultConfig = installedConfigs.get("default")!;
      expect(astraConfig["model"]).toBe("gpt-6-astra");
      expect(lowConfig["model"]).toBe("gpt-6-sol");
      expect(defaultConfig["model"]).toBe("gpt-6-sol");

      const astraInstructions = astraConfig["developer_instructions"] as string;
      const solInstructions = rootDeveloperInstructions({
        frontend: true,
        security: true,
        rootModel: "gpt-6-sol",
      });
      expect(astraInstructions).toBe(
        rootDeveloperInstructions({
          frontend: true,
          security: true,
          rootModel: "gpt-6-astra",
        }),
      );
      expect(astraInstructions).toContain("longest practical event wait");
      expect(astraInstructions).toMatch(
        /collaboration\.wait_agent.*timeout_ms=1200000.*20 minutes.*cache lifetime/isu,
      );
      expect(astraInstructions).toMatch(/early specialist completion wakes.*collective mailbox/isu);
      expect(astraInstructions).toMatch(/maximum wait expires.*same maximum wait again/isu);
      expect(lowConfig["developer_instructions"]).toBe(solInstructions);
      expect(defaultConfig["developer_instructions"]).toBe(solInstructions);
      expect(solInstructions).toContain("longest practical event wait");
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
          optional: { frontend: false, security: false, computer_use: true },
          officialPlugins: [additionalPlugin],
        },
        manager,
      );
      let initialRequest: InstallRequest | undefined;
      const result = await runCli(
        ["install", "--profile", "low", "--frontend", "--codex-home", codexHome],
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
        optional: { frontend: true, security: false, computer_use: true },
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
          optional: { frontend: false, security: false, computer_use: false },
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
        optional: { frontend: false, security: false, computer_use: false },
        officialPlugins: [additionalPlugin],
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
          { optional: { frontend: false, security: false, computer_use: false } },
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
              optional: { frontend: false, security: false, computer_use: false },
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
          optional: { frontend: false, security: false, computer_use: false },
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
          optional: { frontend: false, security: false, computer_use: false },
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

  test("removes deselected owned plugins while preserving foreign plugin state", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-deselect-"));
    const codexHome = join(root, "codex");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const foreignPlugin = "foreign-plugin@openai-curated";
    const manager = fakeManager({
      initial: {
        [additionalPlugin]: "available",
        [foreignPlugin]: "installed",
      },
    });
    try {
      const initial = await installHolyCodex(
        {
          optional: { computer_use: false, frontend: true, security: false },
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
      await writeFile(
        paths.configFile,
        `${await readFile(paths.configFile, "utf8")}\n[plugins."${foreignPlugin}"]\nenabled = false\nsource = "external"\n`,
      );

      const reconciled = await installHolyCodex(
        {
          optional: { computer_use: false, frontend: false, security: false },
          officialPlugins: [],
        },
        installerOptions(codexHome, manager),
        fakeEnvironment,
      );

      expect(reconciled.record.official_plugins).toEqual([]);
      expect(reconciled.record.owned_plugins).toEqual(["holycodex@holycodex"]);
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
      expect((await manager.list!()).installed.map((entry) => entry.pluginId)).not.toContain(
        "build-web-apps@openai-curated",
      );
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

  test("reconstructs legacy selections for internal migration review", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-upgrade-keep-"));
    const manager = fakeManager({ initial: { [additionalPlugin]: "available" } });
    try {
      const { codexHome } = await seedInstall(
        root,
        {
          profile: "high",
          tier: "fast",
          optional: { frontend: false, security: false, computer_use: false },
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
        optional: { frontend: false, security: false, computer_use: false },
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
      await seedInstall(
        root,
        { optional: { frontend: false, security: false, computer_use: false } },
        manager,
      );
      await makeLegacy(codexHome);
      await writeFile(
        paths.configFile,
        (await readFile(paths.configFile, "utf8"))
          .replace('model = "gpt-6-sol"', 'model = "gpt-5.6-terra"')
          .replace("context_management = true", 'context_management = false\nunrelated = "keep"'),
      );
      rewriteOnAdd = true;

      await installHolyCodex(
        { optional: { frontend: false, security: false, computer_use: false } },
        {
          ...installerOptions(codexHome, manager),
          resolveConflicts: async (conflicts) =>
            Object.fromEntries(
              conflicts.map((conflict) => [
                conflict.identity!,
                conflict.key === "features.context_management" ? "replace" : "keep",
              ]),
            ),
          reviewInstall: async () => ({ action: "apply" }),
        },
        fakeEnvironment,
      );

      const finalConfig = await readFile(paths.configFile, "utf8");
      expect(finalConfig).toContain('model = "gpt-5.6-terra"');
      expect(finalConfig).toContain("context_management = true");
      expect(finalConfig).toContain('unrelated = "keep"');

      await manager.remove?.("holycodex@holycodex");
      await installHolyCodex(
        { optional: { frontend: false, security: false, computer_use: false } },
        {
          ...installerOptions(codexHome, manager),
          reviewInstall: async () => ({ action: "apply" }),
        },
        fakeEnvironment,
      );
      const reinstalledConfig = await readFile(paths.configFile, "utf8");
      expect(reinstalledConfig).toContain('model = "gpt-5.6-terra"');
      expect(reinstalledConfig).toContain("context_management = true");
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
        { optional: { frontend: false, security: false, computer_use: false } },
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
      ).toBeDefined();
      const missingDoctor = await doctorHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
        runtime: testRuntime(codexHome),
      });
      expect(missingDoctor.healthy).toBe(false);
      expect(missingDoctor.checks["runtime_config"]?.reasons).toContain("changed_holycodex_config");
      expect(missingDoctor.checks["runtime_config"]?.details["keys"]).toContain("model");
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
          optional: { frontend: false, security: false, computer_use: false },
          officialPlugins: [additionalPlugin],
        },
        manager,
      );
      await makeLegacy(codexHome);
      const selected: InstallRequest = {
        profile: "low",
        tier: "standard",
        optional: { frontend: true, security: false, computer_use: false },
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
          "--no-frontend",
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
                    optional: { frontend: true, security: false, computer_use: false },
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
          optional: { frontend: false },
          officialPlugins: [additionalPlugin],
        },
        {
          profile: "high",
          tier: "fast",
          optional: { frontend: false, security: true, computer_use: false },
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
