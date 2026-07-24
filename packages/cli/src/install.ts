import { cp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { pluginRoot } from "@holycodex/plugin";

import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../../git-bash-mcp/src/git-bash-resolver.ts";
import {
  AGENTS,
  DEFAULT_PLAN,
  effectiveMcpServers,
  MANAGED_AGENT_MODEL_HISTORY,
  MANAGED_AGENT_MODEL_HISTORY_BY_PLAN,
  MODEL_ROUTING_PLANS,
  type PlanName,
  VERSION,
  WINDOWS_SHELL_POLICY,
} from "./catalog.ts";
import { installConfig, readManagedPlan, removeManaged, type AutonomyMode } from "./config.ts";
import { atomicWrite, backup, exists, readText } from "./files.ts";
import { rootTomlString } from "./toml.ts";

export type RunOptions = {
  readonly autonomy: AutonomyMode;
  readonly json: boolean;
  readonly plan?: PlanName;
  readonly maxSubagents?: number;
};
export type RunResult = {
  readonly action: "install" | "cleanup";
  readonly changed: readonly string[];
  readonly backups: readonly string[];
  readonly plan?: PlanName;
  readonly maxSubagents?: number;
};
export type InstallRuntime = {
  readonly platform: NodeJS.Platform;
  readonly gitBash: () => GitBashResolution;
};

const defaultRuntime: InstallRuntime = {
  platform: process.platform,
  gitBash: resolveGitBashForCurrentProcess,
};

function paths(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  const marketplaceCache = join(home, "plugins", "cache", "holycodex");
  const cacheRoot = join(marketplaceCache, "holycodex");
  return {
    home,
    config: join(home, "config.toml"),
    marketplaceCache,
    cacheRoot,
    cache: join(cacheRoot, VERSION),
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

/** Validates git bash ready. */
export function assertGitBashReady(platform: NodeJS.Platform, resolution: GitBashResolution): void {
  if (platform !== "win32") return;
  if (!resolution.found) throw new Error(resolution.installHint);
}

/** Provides install. */
export async function install(
  options: RunOptions,
  runtime: InstallRuntime = defaultRuntime,
): Promise<RunResult> {
  assertGitBashReady(runtime.platform, runtime.gitBash());
  const plan = options.plan ?? DEFAULT_PLAN;
  const target = paths();
  const root = backupRoot();
  const backups = [
    await backup(target.config, root),
    await backup(target.marketplaceCache, root),
    await backup(target.agents, root),
    ...(await Promise.all(target.legacy.map((path) => backup(path, root)))),
  ].filter((path) => path !== undefined);
  const existingConfig = await readText(target.config);
  const previousPlan = readManagedPlan(existingConfig);
  const config = installConfig(
    existingConfig,
    options.autonomy,
    runtime.platform,
    plan,
    options.maxSubagents,
  );
  await atomicWrite(target.config, config);
  await rm(target.cache, { recursive: true, force: true });
  await mkdir(dirname(target.cache), { recursive: true });
  await cp(pluginRoot, target.cache, { recursive: true });
  await writePlatformPlugin(target.cache, runtime.platform, plan);
  const existingAgentPreferences = await readAgentPreferences(target.agents, previousPlan);
  await rm(target.agents, { recursive: true, force: true });
  await cp(join(pluginRoot, "agents"), target.agents, { recursive: true });
  await writeInstalledAgents(target.agents, runtime.platform, plan);
  await preserveAgentPreferences(target.agents, existingAgentPreferences);
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
    plan,
    ...(options.maxSubagents === undefined ? {} : { maxSubagents: options.maxSubagents }),
  };
}

type AgentPreferences = Partial<Record<(typeof AGENTS)[number], AgentModelPreference>>;
type AgentModelPreference = { readonly model?: string; readonly reasoningEffort?: string };

async function readAgentPreferences(
  root: string,
  previousPlan: PlanName | undefined,
): Promise<AgentPreferences> {
  const preferences: AgentPreferences = {};
  await Promise.all(
    AGENTS.map(async (agent) => {
      const source = await readText(join(root, `${agent}.toml`));
      const model = rootTomlString(source, "model");
      const reasoningEffort = rootTomlString(source, "model_reasoning_effort");
      if (model === undefined && reasoningEffort === undefined) return;
      const managedRoutes =
        previousPlan === undefined
          ? MANAGED_AGENT_MODEL_HISTORY[agent]
          : MANAGED_AGENT_MODEL_HISTORY_BY_PLAN[previousPlan][agent];
      const managed = managedRoutes.some(
        (item) => item.model === model && item.reasoningEffort === reasoningEffort,
      );
      if (!managed)
        preferences[agent] = {
          ...(model === undefined ? {} : { model }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        };
    }),
  );
  return preferences;
}

async function preserveAgentPreferences(
  root: string,
  preferences: AgentPreferences,
): Promise<void> {
  await Promise.all(
    AGENTS.map(async (agent) => {
      const preference = preferences[agent];
      if (preference === undefined) return;
      const path = join(root, `${agent}.toml`);
      let source = await readText(path);
      if (preference.model !== undefined)
        source = replaceTomlString(source, "model", preference.model);
      if (preference.reasoningEffort !== undefined)
        source = replaceTomlString(source, "model_reasoning_effort", preference.reasoningEffort);
      await atomicWrite(path, source);
    }),
  );
}

function replaceTomlString(input: string, key: string, value: string): string {
  return input.replace(new RegExp(`^${key}\\s*=.*$`, "m"), `${key} = ${JSON.stringify(value)}`);
}

async function writePlatformPlugin(
  root: string,
  platform: NodeJS.Platform,
  plan: PlanName,
): Promise<void> {
  await atomicWrite(
    join(root, ".mcp.json"),
    `${JSON.stringify({ mcpServers: effectiveMcpServers(platform) }, null, 2)}\n`,
  );
  await writeInstalledAgents(join(root, "agents"), platform, plan);
}

async function writeInstalledAgents(
  root: string,
  platform: NodeJS.Platform,
  plan: PlanName,
): Promise<void> {
  await Promise.all(
    AGENTS.map(async (agent) => {
      const path = join(root, `${agent}.toml`);
      const route = MODEL_ROUTING_PLANS[plan].agents[agent];
      let source = await readText(path);
      source = replaceTomlString(source, "model", route.model);
      source = replaceTomlString(source, "model_reasoning_effort", route.reasoningEffort);
      if (platform === "win32") {
        await atomicWrite(path, source);
        return;
      }
      await atomicWrite(
        path,
        source
          .replace(`${WINDOWS_SHELL_POLICY}\r\n\r\n`, "")
          .replace(`${WINDOWS_SHELL_POLICY}\n\n`, ""),
      );
    }),
  );
}

/** Provides cleanup. */
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
