import { cp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installConfig, removeManaged } from "./config.ts";
import { atomicWrite, backup, exists, readText } from "./files.ts";

export type RunOptions = { readonly autonomous: boolean; readonly json: boolean };
export type RunResult = {
  readonly action: "install" | "cleanup";
  readonly changed: readonly string[];
  readonly backups: readonly string[];
};

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function paths(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  return {
    home,
    config: join(home, "config.toml"),
    cache: join(home, "plugins", "cache", "holycodex", "holycodex", "0.1.0"),
    agents: join(home, "holycodex", "agents"),
  };
}

function backupRoot(): string {
  return join(tmpdir(), "holycodex-backups", new Date().toISOString().replaceAll(":", "-"));
}

export async function install(options: RunOptions): Promise<RunResult> {
  const target = paths();
  const root = backupRoot();
  const backups = [
    await backup(target.config, root),
    await backup(target.cache, root),
    await backup(target.agents, root),
  ].filter((path) => path !== undefined);
  const config = installConfig(await readText(target.config), options.autonomous);
  await atomicWrite(target.config, config);
  await mkdir(dirname(target.cache), { recursive: true });
  await rm(target.cache, { recursive: true, force: true });
  await cp(join(packageRoot, "plugin"), target.cache, { recursive: true });
  await rm(target.agents, { recursive: true, force: true });
  await cp(join(packageRoot, "plugin", "agents"), target.agents, { recursive: true });
  return { action: "install", changed: [target.config, target.cache, target.agents], backups };
}

export async function cleanup(_options: RunOptions): Promise<RunResult> {
  const target = paths();
  const root = backupRoot();
  const backups = [
    await backup(target.config, root),
    await backup(target.cache, root),
    await backup(target.agents, root),
  ].filter((path) => path !== undefined);
  const changed: string[] = [];
  if (await exists(target.config)) {
    const current = await readText(target.config);
    const cleaned = `${removeManaged(current)}\n`;
    if (cleaned !== current) {
      await atomicWrite(target.config, cleaned);
      changed.push(target.config);
    }
  }
  if (await exists(target.cache)) {
    await rm(target.cache, { recursive: true });
    changed.push(target.cache);
  }
  if (await exists(target.agents)) {
    await rm(target.agents, { recursive: true });
    changed.push(target.agents);
  }
  return { action: "cleanup", changed, backups };
}
