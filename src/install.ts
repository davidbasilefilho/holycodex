import { cp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installConfig, removeManaged, type AutonomyMode } from "./config.ts";
import { atomicWrite, backup, exists, readText } from "./files.ts";
import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../packages/git-bash-mcp/src/git-bash-resolver.ts";

export type RunOptions = { readonly autonomy: AutonomyMode; readonly json: boolean };
export type RunResult = {
  readonly action: "install" | "cleanup";
  readonly changed: readonly string[];
  readonly backups: readonly string[];
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(moduleDirectory, basename(moduleDirectory) === "runtime" ? "../.." : "..");

function paths(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  const marketplaceCache = join(home, "plugins", "cache", "holycodex");
  const cacheRoot = join(marketplaceCache, "holycodex");
  return {
    home,
    config: join(home, "config.toml"),
    marketplaceCache,
    cacheRoot,
    cache: join(cacheRoot, "0.5.3"),
    agents: join(home, "holycodex", "agents"),
    legacy: [
      join(home, "plugins", "cache", "sisyphuslabs", "omo"),
      join(home, "plugins", "cache", "lazycodex", "omo"),
      join(home, "plugins", "cache", "code-yeongyu-codex-plugins", "omo"),
    ],
  };
}

function backupRoot(): string {
  return join(tmpdir(), "holycodex-backups", new Date().toISOString().replaceAll(":", "-"));
}

export function assertGitBashReady(
  resolution: GitBashResolution = resolveGitBashForCurrentProcess(),
): void {
  if (!resolution.found) throw new Error(resolution.installHint);
}

export async function install(options: RunOptions): Promise<RunResult> {
  assertGitBashReady();
  const target = paths();
  const root = backupRoot();
  const backups = [
    await backup(target.config, root),
    await backup(target.marketplaceCache, root),
    await backup(target.agents, root),
    ...(await Promise.all(target.legacy.map((path) => backup(path, root)))),
  ].filter((path) => path !== undefined);
  const config = installConfig(await readText(target.config), options.autonomy);
  await atomicWrite(target.config, config);
  await rm(target.marketplaceCache, { recursive: true, force: true });
  await mkdir(dirname(target.cache), { recursive: true });
  await cp(join(packageRoot, "plugin"), target.cache, { recursive: true });
  await rm(target.agents, { recursive: true, force: true });
  await cp(join(packageRoot, "plugin", "agents"), target.agents, { recursive: true });
  const removedLegacy: string[] = [];
  for (const path of target.legacy) {
    if (!(await exists(path))) continue;
    await rm(path, { recursive: true });
    removedLegacy.push(path);
  }
  return {
    action: "install",
    changed: [target.config, target.cache, target.agents, ...removedLegacy],
    backups,
  };
}

export async function cleanup(_options: RunOptions): Promise<RunResult> {
  const target = paths();
  const root = backupRoot();
  const backups = [
    await backup(target.config, root),
    await backup(target.marketplaceCache, root),
    await backup(target.agents, root),
  ].filter((path) => path !== undefined);
  const changed: string[] = [];
  if (await exists(target.config)) {
    const current = await readText(target.config);
    const unmanaged = removeManaged(current);
    const cleaned = `${unmanaged}\n`;
    if (unmanaged.length === 0 && current.includes("# >>> holycodex managed >>>")) {
      await rm(target.config);
      changed.push(target.config);
    } else if (cleaned !== current) {
      await atomicWrite(target.config, cleaned);
      changed.push(target.config);
    }
  }
  if (await exists(target.marketplaceCache)) {
    await rm(target.marketplaceCache, { recursive: true });
    changed.push(target.marketplaceCache);
  }
  if (await exists(target.agents)) {
    await rm(target.agents, { recursive: true });
    changed.push(target.agents);
  }
  return { action: "cleanup", changed, backups };
}
