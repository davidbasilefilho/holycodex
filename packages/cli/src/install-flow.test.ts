// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  runCli,
} from "./index.ts";

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

  test("reconstructs legacy selections for Upgrade and keeps them through final review", async () => {
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
      let upgradeChoice: InstallRequest | undefined;
      let confirmationCalls = 0;
      let reviewOperation: string | undefined;
      let reviewRequest: InstallRequest | undefined;
      const result = await runCli(
        ["upgrade", "--codex-home", codexHome],
        commandContext(codexHome, manager, {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          confirm: async () => {
            confirmationCalls += 1;
            return true;
          },
          upgradeWizard: async (current) => {
            upgradeChoice = current;
            return { action: "keep" };
          },
          installReview: async (review) => {
            reviewOperation = review.operation;
            reviewRequest = {
              profile: review.profile,
              tier: review.tier,
              optional: review.capabilities,
              officialPlugins: review.additionalPlugins,
            };
            return { action: "apply" };
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.envelope).toMatchObject({ ok: true, command: "upgrade" });
      expect(upgradeChoice).toEqual({
        profile: "high",
        tier: "fast",
        optional: { frontend: false, security: false, computer_use: false },
        officialPlugins: [additionalPlugin],
      });
      expect(confirmationCalls).toBe(0);
      expect(reviewOperation).toBe("upgrade");
      expect(reviewRequest).toEqual(upgradeChoice);
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
          .replace('model = "gpt-6-astra"', 'model = "gpt-5.6-terra"')
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

  test("prepopulates Change options for an upgrade and reviews the changed request", async () => {
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
      let prefilled: InstallRequest | undefined;
      let reviewRequest: InstallRequest | undefined;
      const result = await runCli(
        ["upgrade", "--codex-home", codexHome],
        commandContext(codexHome, manager, {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          upgradeWizard: async () => ({ action: "change" }),
          installWizard: async (current) => {
            prefilled = current;
            return {
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
            reviewRequest = {
              profile: review.profile,
              tier: review.tier,
              optional: review.capabilities,
              officialPlugins: review.additionalPlugins,
            };
            return { action: "apply" };
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(prefilled).toEqual({
        profile: "high",
        tier: "fast",
        optional: { frontend: false, security: false, computer_use: false },
        officialPlugins: [additionalPlugin],
      });
      expect(reviewRequest).toEqual({
        profile: "low",
        tier: "standard",
        optional: { frontend: true, security: false, computer_use: false },
        officialPlugins: [additionalPlugin],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("honors an upgrade choice request without reopening the install wizard", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-upgrade-request-"));
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
      const request: InstallRequest = {
        profile: "low",
        tier: "standard",
        optional: { frontend: true, security: false, computer_use: false },
        officialPlugins: [],
      };
      let installWizardCalls = 0;
      let reviewRequest: InstallRequest | undefined;
      const result = await runCli(
        ["upgrade", "--codex-home", codexHome],
        commandContext(codexHome, manager, {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          upgradeWizard: async () => ({ action: "change", request }),
          installWizard: async (current) => {
            installWizardCalls += 1;
            return { action: "install", request: current };
          },
          installReview: async (review) => {
            reviewRequest = {
              profile: review.profile,
              tier: review.tier,
              optional: review.capabilities,
              officialPlugins: review.additionalPlugins,
            };
            return { action: "apply" };
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(installWizardCalls).toBe(0);
      expect(reviewRequest).toEqual(request);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps non-interactive upgrade modes out of both prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-upgrade-modes-"));
    const manager = fakeManager();
    try {
      const { codexHome } = await seedInstall(
        root,
        { optional: { frontend: false, security: false, computer_use: false } },
        manager,
      );
      await makeLegacy(codexHome);
      let confirmationCalls = 0;
      let wizardCalls = 0;
      const io = {
        stdoutIsTTY: true,
        stderrIsTTY: true,
        confirm: async () => {
          confirmationCalls += 1;
          return true;
        },
        upgradeWizard: async () => {
          wizardCalls += 1;
          return { action: "cancel" as const };
        },
      };

      const json = await runCli(["upgrade", "--json", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io,
        installer: installerOptions(codexHome, manager),
      });
      expect(json.exitCode).toBe(1);
      expect(json.envelope).toMatchObject({
        ok: false,
        error: { code: "non_tty_confirmation_required" },
      });

      const nonTty = await runCli(["upgrade", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io: { ...io, stdoutIsTTY: false, stderrIsTTY: false },
        installer: installerOptions(codexHome, manager),
      });
      expect(nonTty.exitCode).toBe(1);
      expect(nonTty.envelope).toMatchObject({
        ok: false,
        error: { code: "non_tty_confirmation_required" },
      });

      const yes = await runCli(["upgrade", "--yes", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io,
        installer: installerOptions(codexHome, manager),
      });
      expect(yes.exitCode).toBe(0);
      expect(yes.envelope).toMatchObject({ ok: true, command: "upgrade" });
      expect(confirmationCalls).toBe(0);
      expect(wizardCalls).toBe(0);
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

  test("refuses unresolved JSON upgrade conflicts and --yes resolves them safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-flow-conflicts-"));
    const manager = fakeManager();
    try {
      const { codexHome } = await seedInstall(
        root,
        { optional: { frontend: false, security: false, computer_use: false } },
        manager,
      );
      await makeLegacy(codexHome);
      const rolePath = join(codexHome, "holycodex", "agents", "Worker.implementation.toml");
      const originalRole = await readFile(rolePath, "utf8");
      await writeFile(rolePath, "user edit\n");

      const unresolved = await runCli(["upgrade", "--json", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io: { stdoutIsTTY: false, stderrIsTTY: false },
        installer: installerOptions(codexHome, manager),
      });
      expect(unresolved.exitCode).toBe(1);
      expect(unresolved.envelope).toMatchObject({
        ok: false,
        error: { code: "confirmation_required" },
      });
      expect(await readFile(rolePath, "utf8")).toBe("user edit\n");

      const accepted = await runCli(["upgrade", "--yes", "--json", "--codex-home", codexHome], {
        env: fakeEnvironment,
        io: { stdoutIsTTY: false, stderrIsTTY: false },
        installer: installerOptions(codexHome, manager),
      });
      expect(accepted.exitCode).toBe(0);
      expect(accepted.envelope).toMatchObject({ ok: true, command: "upgrade" });
      expect(await readFile(rolePath, "utf8")).toBe(originalRole);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function reviewOperation(review: { readonly operation: string }): string {
  return review.operation;
}
