// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTomlPath } from "@holycodex/codex";
import type { TomlDocument, TomlValue } from "@holycodex/codex";

import {
  doctorHolyCodex,
  installHolyCodex,
  readActiveInstallRecord,
  removeHolyCodex,
  resolveInstallerPaths,
} from "./index.ts";
import type {
  InstallRequest,
  InstallReview,
  InstallerRuntime,
  ManagedConflict,
  OfficialPluginManager,
} from "./index.ts";
import {
  assertInstallTransactionState,
  diagnoseInstallTransactions,
  parseConfig,
  serializeConfig,
} from "./installer.ts";

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
  optional: { frontend: false, security: false },
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

describe("installer preflight", () => {
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
        expect.arrayContaining([expect.objectContaining({ name: "context7", status: "ready" })]),
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

  test("surfaces multiple config and role conflicts with independent decisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-conflicts-"));
    const codexHome = join(root, "codex");
    try {
      const { manager, runtime } = await installBaseline(codexHome);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      await writeFile(
        paths.configFile,
        (await readFile(paths.configFile, "utf8"))
          .replace('model = "gpt-6-astra"', 'model = "gpt-5.6-terra"')
          .replace("context_management = true", "context_management = false"),
      );
      const rolePath = join(paths.roleRoot, "Worker.implementation.toml");
      const userRole = "user role edit\n";
      await writeFile(rolePath, userRole);
      let review: InstallReview | undefined;

      const result = await installHolyCodex(
        { tier: "fast-all", ...request },
        {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflict: async (conflict) =>
            conflict.category === "role-asset" || conflict.key === "model" ? "decline" : "accept",
          reviewInstall: async (value) => {
            review = value;
            return { action: "apply" };
          },
        },
      );

      expect(review?.conflictCounts["config-key"]).toBeGreaterThanOrEqual(2);
      expect(review?.conflictCounts["role-asset"]).toBeGreaterThanOrEqual(1);
      expect(await readFile(paths.configFile, "utf8")).toContain('model = "gpt-5.6-terra"');
      expect(await readFile(paths.configFile, "utf8")).toContain("context_management = true");
      expect(await readFile(rolePath, "utf8")).toBe(userRole);
      expect(result.preserved).toContain(rolePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("resolves managed config and role conflicts in one batch without pre-review mutation", async () => {
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
          .replace('model = "gpt-6-astra"', 'model = "gpt-5.6-terra"')
          .replace("context_management = true", 'context_management = false\nunrelated = "keep"'),
      );
      const rolePath = join(paths.roleRoot, "Worker.implementation.toml");
      const userRole = "batch user role edit\n";
      await writeFile(rolePath, userRole);
      const preflightConfig = await readFile(paths.configFile, "utf8");
      const preflightRole = await readFile(rolePath, "utf8");
      events.length = 0;

      const result = await installHolyCodex(
        { tier: "fast-all", ...request },
        {
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
        },
      );

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
            conflict.category === "config-key" && conflict.key === "features.context_management",
        ),
      ).toBe(true);
      expect(callbackConfigs).toEqual([preflightConfig]);
      expect(callbackRoles).toEqual([preflightRole]);
      expect(callbackEvents).toEqual([[]]);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.conflictCounts["config-key"]).toBeGreaterThanOrEqual(2);
      expect(reviews[0]?.conflictCounts["role-asset"]).toBeGreaterThanOrEqual(1);
      const finalConfig = await readFile(paths.configFile, "utf8");
      expect(finalConfig).toContain('model = "gpt-6-astra"');
      expect(finalConfig).toContain("context_management = false");
      expect(finalConfig).toContain('unrelated = "keep"');
      expect(await readFile(rolePath, "utf8")).toBe(userRole);
      expect(result.preserved).toContain(rolePath);
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
      await writeTestConfigValue(paths, "features.context_management", false);
      await writeTestConfigValue(paths, "unrelated", "keep");

      await installHolyCodex(request, {
        paths: { codexHome },
        officialPluginManager: manager,
        runtime,
        resolveConflicts: async (conflicts) =>
          Object.fromEntries(
            conflicts.map((conflict) => [
              conflict.identity!,
              conflict.key === "features.context_management" ? "replace" : "keep",
            ]),
          ),
        reviewInstall: async () => ({ action: "apply" }),
      });

      const finalConfig = await readFile(paths.configFile, "utf8");
      expect(finalConfig).toContain('model = "gpt-5.6-terra"');
      expect(finalConfig).toContain("context_management = true");
      expect(finalConfig).toContain('unrelated = "keep"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("reopens conflict resolution before returning to final review and apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-preflight-resolve-"));
    const codexHome = join(root, "codex");
    try {
      const { manager, runtime } = await installBaseline(codexHome);
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      const rolePath = join(paths.roleRoot, "Worker.implementation.toml");
      const userRole = "reopened user role\n";
      await writeFile(rolePath, userRole);
      const reviews: InstallReview[] = [];
      let reviewCalls = 0;

      const result = await installHolyCodex(
        { tier: "fast-all", ...request },
        {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
          resolveConflict: async () => "decline",
          reviewInstall: async (value) => {
            reviews.push(value);
            reviewCalls += 1;
            return reviewCalls === 1 ? { action: "resolve" } : { action: "apply" };
          },
        },
      );

      expect(reviews).toHaveLength(2);
      expect(reviews[0]?.conflictCounts["role-asset"]).toBeGreaterThanOrEqual(1);
      expect(reviews[1]?.conflictCounts["role-asset"]).toBeGreaterThanOrEqual(1);
      expect(await readFile(rolePath, "utf8")).toBe(userRole);
      expect(result.preserved).toContain(rolePath);
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
      optional: { frontend: true, security: false },
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
      optional: { frontend: true, security: false },
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
        optional: { frontend: true, security: false },
      };
      try {
        await installHolyCodex(frontendRequest, {
          paths: { codexHome },
          officialPluginManager: manager,
          runtime,
        });
        await writeTestConfigValue(paths, 'plugins."holycodex@holycodex"', { enabled: false });
        await writeTestConfigValue(paths, "marketplaces.holycodex", {
          source_type: "git",
          source: "https://example.test/custom-holycodex.git",
        });
        await writeTestConfigValue(paths, 'plugins."build-web-apps@openai-curated"', {
          enabled: false,
        });
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
        expect(readTestConfigEntry(finalConfig, "plugins", "holycodex@holycodex")).toEqual({
          enabled: expectedEnabled,
        });
        expect(
          readTestConfigEntry(finalConfig, "plugins", "build-web-apps@openai-curated"),
        ).toEqual({
          enabled: expectedEnabled,
        });
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
        expect(pluginConfig.before.preference.safe_value).toEqual(
          decision === "replace" ? undefined : { kind: "boolean", value: false },
        );
        expect(pluginConfig.after.preference.safe_value).toEqual({
          kind: "boolean",
          value: expectedEnabled,
        });
        if (decision === "keep") {
          expect(pluginConfig.before.marketplace.digest).toBe(
            pluginConfig.after.marketplace.digest,
          );
        } else {
          expect(pluginConfig.before.marketplace.digest).not.toBe(
            pluginConfig.after.marketplace.digest,
          );
        }
        expect(providerConfig.before.safe_value).toEqual(
          decision === "replace" ? undefined : { kind: "boolean", value: false },
        );
        expect(providerConfig.after.safe_value).toEqual({
          kind: "boolean",
          value: expectedEnabled,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
