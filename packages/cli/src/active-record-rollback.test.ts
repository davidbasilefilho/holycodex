// SPDX-License-Identifier: Apache-2.0

import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTomlPath, type TomlDocument, type TomlValue } from "@holycodex/codex";

import { resolveInstallerPaths, type ResolvedInstallerPaths } from "./paths.ts";
import type { InstallerRuntime, OfficialPluginManager } from "./types.ts";

const realFs = await import("node:fs/promises");
const realOpen = realFs.open;
const realRename = realFs.rename;
const realMkdtemp = realFs.mkdtemp;
const realMkdir = realFs.mkdir;
const realReadFile = realFs.readFile;
const realRm = realFs.rm;
const realWriteFile = realFs.writeFile;

type InstallerModule = typeof import("./installer.ts");

function testRuntime(codexHome: string): InstallerRuntime {
  const state = { installed: false };
  const binRoot = "/fake/rollback/bin";
  const projectRoot = "/fake/rollback/install/global";
  const packageRoot = `${projectRoot}/node_modules/ctx7`;
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
          [binRoot, projectRoot].includes(normalizedPath) ||
          (state.installed && [packageRoot, packageExecutable, shim].includes(normalizedPath))
        ) {
          return;
        }
        throw new Error("missing");
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

function tomlTable(value: TomlValue | undefined): Record<string, TomlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, TomlValue>)
    : {};
}

async function writeConfigValue(
  paths: ResolvedInstallerPaths,
  installer: InstallerModule,
  keyPath: string,
  value: TomlValue,
): Promise<void> {
  const source = await realReadFile(paths.configFile, "utf8").catch(() => undefined);
  const document = installer.parseConfig(source);
  const quotedPluginKey = /^plugins\."(.*)"$/u.exec(keyPath)?.[1];
  const next: TomlDocument =
    quotedPluginKey === undefined
      ? writeTomlPath(document, keyPath, value)
      : writeTomlPath(document, "plugins", {
          ...tomlTable(document["plugins"]),
          [quotedPluginKey]: value,
        });
  await realWriteFile(paths.configFile, installer.serializeConfig(next));
}

function configWritingManager(
  paths: ResolvedInstallerPaths,
  installer: InstallerModule,
  initialInstalled: readonly string[] = [],
): OfficialPluginManager {
  const states = new Map(
    initialInstalled.map((pluginId) => [pluginId, { installed: true, enabled: true }] as const),
  );
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
      await writeConfigValue(paths, installer, "marketplaces.holycodex", {
        source_type: "git",
        source:
          source === "davidbasilefilho/holycodex"
            ? "https://github.com/davidbasilefilho/holycodex.git"
            : source,
      });
    },
    add: async (pluginId) => {
      states.set(pluginId, { installed: true, enabled: true });
      await writeConfigValue(paths, installer, `plugins."${pluginId}"`, { enabled: true });
    },
    remove: async (pluginId) => {
      states.delete(pluginId);
    },
  };
}

async function snapshotManagedArtifacts(
  recordText: string,
  codexHome: string,
): Promise<readonly (readonly [string, string])[]> {
  const record = JSON.parse(recordText) as {
    readonly managed_artifacts: readonly { readonly path: string }[];
  };
  return await Promise.all(
    record.managed_artifacts.map(
      async ({ path }) => [path, await realReadFile(join(codexHome, path), "utf8")] as const,
    ),
  );
}

test("rolls back all effects after active-record post-rename sync failure", async () => {
  const root = await realMkdtemp(join(tmpdir(), "holycodex-active-record-rollback-"));
  const codexHome = join(root, "codex");
  const activeDirectory = join(codexHome, "holycodex");
  let faultTarget: string | undefined;
  let directorySyncFailureArmed = false;
  let directorySyncFailures = 0;
  const mockedRename = async (
    from: Parameters<typeof realRename>[0],
    to: Parameters<typeof realRename>[1],
  ) => {
    const result = await realRename(from, to);
    if (faultTarget !== undefined && to.toString() === faultTarget) {
      faultTarget = undefined;
      directorySyncFailureArmed = true;
    }
    return result;
  };
  const mockedOpen = async (
    path: Parameters<typeof realOpen>[0],
    flags: Parameters<typeof realOpen>[1],
    mode?: Parameters<typeof realOpen>[2],
  ) => {
    const handle = await realOpen(path, flags, mode);
    if (
      directorySyncFailureArmed &&
      typeof path !== "number" &&
      path.toString() === activeDirectory
    ) {
      directorySyncFailureArmed = false;
      directorySyncFailures += 1;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "sync") {
            return async () => {
              throw new Error("injected post-rename directory sync failure");
            };
          }
          if (property === "close") {
            return (...args: Parameters<typeof handle.close>) => handle.close(...args);
          }
          return Reflect.get(target, property, receiver);
        },
      });
    }
    return handle;
  };
  await mock.module("node:fs/promises", () => ({
    ...realFs,
    open: mockedOpen,
    rename: mockedRename,
  }));

  try {
    const installerModulePath = "./installer.ts?active-record-rollback";
    const installer = await import(installerModulePath);
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    await realMkdir(codexHome, { recursive: true });
    await realWriteFile(
      paths.configFile,
      '[marketplaces.holycodex]\nsource_type = "git"\nsource = "https://github.com/davidbasilefilho/holycodex.git"\n\n[plugins."holycodex@holycodex"]\nenabled = true\n',
    );
    const baseManager = configWritingManager(paths, installer, ["holycodex@holycodex"]);
    const manager: OfficialPluginManager = {
      ...baseManager,
      list: async () => {
        const live = await baseManager.list!();
        return {
          ...live,
          installed: [
            ...live.installed,
            { pluginId: "unmanaged@third-party", installed: true, enabled: false },
          ],
        };
      },
    };
    const runtime = testRuntime(codexHome);
    await installer.installHolyCodex(
      { optional: { computer_use: false, frontend: false, security: false } },
      { paths: { codexHome }, officialPluginManager: manager, runtime },
    );
    const activeBefore = await realReadFile(paths.activeRecord, "utf8");
    const optionsBefore = await realReadFile(paths.installOptions, "utf8");
    const configBefore = await realReadFile(paths.configFile, "utf8");
    const artifactsBefore = await snapshotManagedArtifacts(activeBefore, codexHome);
    const pluginsBefore = await manager.list!();

    faultTarget = paths.activeRecord;
    let failure: unknown;
    try {
      await installer.installHolyCodex(
        {
          profile: "high",
          tier: "fast-all",
          optional: { computer_use: false, frontend: false, security: false },
        },
        { paths: { codexHome }, officialPluginManager: manager, runtime },
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "install_failed" });
    expect(directorySyncFailures).toBe(1);
    expect(await realReadFile(paths.activeRecord, "utf8")).toBe(activeBefore);
    expect(await realReadFile(paths.installOptions, "utf8")).toBe(optionsBefore);
    expect(await realReadFile(paths.configFile, "utf8")).toBe(configBefore);
    expect(await snapshotManagedArtifacts(activeBefore, codexHome)).toEqual(artifactsBefore);
    expect(await manager.list!()).toEqual(pluginsBefore);
    await expect(realReadFile(paths.preparingRecord, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(realReadFile(paths.conflictedRecord, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    mock.restore();
    await realRm(root, { recursive: true, force: true });
  }
});
