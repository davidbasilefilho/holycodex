import { cp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { pluginRoot } from "@holycodex/plugin";

import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../../git-bash-mcp/src/git-bash-resolver.ts";
import { runManagedProcess } from "../../mcp-stdio-core/src/process.ts";
import {
  AGENTS,
  DEFAULT_PLAN,
  effectiveMcpServers,
  MANAGED_AGENT_MODEL_HISTORY,
  MANAGED_AGENT_MODEL_HISTORY_BY_PLAN,
  MODEL_ROUTING_PLANS,
  type FastMode,
  type PlanName,
  VERSION,
  WINDOWS_SHELL_POLICY,
} from "./catalog.ts";
import {
  installCodexSecurity,
  type CodexProcessRunner,
  type CodexSecurityInstallResult,
} from "./codex-security.ts";
import { installConfig, readManagedPlan, removeManaged, type AutonomyMode } from "./config.ts";
import { atomicWrite, backup, exists, readText } from "./files.ts";
import { rootTomlString } from "./toml.ts";

export type RunOptions = {
  readonly autonomy: AutonomyMode;
  readonly fast?: FastMode;
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
  readonly codexSecurity?: CodexSecurityInstallResult;
};
export type InstallRuntime = {
  readonly platform: NodeJS.Platform;
  readonly gitBash: () => GitBashResolution;
  readonly runProcess: CodexProcessRunner;
};

const defaultRuntime: InstallRuntime = {
  platform: process.platform,
  gitBash: resolveGitBashForCurrentProcess,
  runProcess: runManagedProcess,
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
  const fastMode = options.fast ?? "standard";
  const config = installConfig(
    existingConfig,
    options.autonomy,
    runtime.platform,
    plan,
    options.maxSubagents,
    fastMode,
  );
  await atomicWrite(target.config, config);
  await rm(target.cache, { recursive: true, force: true });
  await mkdir(dirname(target.cache), { recursive: true });
  await cp(pluginRoot, target.cache, { recursive: true });
  await writePlatformPlugin(target.cache, runtime.platform, plan, fastMode);
  const existingAgentPreferences = await readAgentPreferences(target.agents, previousPlan);
  await rm(target.agents, { recursive: true, force: true });
  await cp(join(pluginRoot, "agents"), target.agents, { recursive: true });
  await writeInstalledAgents(target.agents, runtime.platform, plan, fastMode);
  await preserveAgentPreferences(target.agents, existingAgentPreferences, plan, fastMode);
  const removedLegacy: string[] = [];
  for (const path of target.legacy) {
    if (!(await exists(path))) continue;
    await rm(path, { recursive: true });
    removedLegacy.push(path);
  }
  const codexSecurity = await installCodexSecurity(
    runtime.runProcess,
    runtime.platform,
    process.env,
  );
  return {
    action: "install",
    changed: [target.config, target.cache, target.agents, ...removedLegacy],
    backups,
    plan,
    codexSecurity,
    ...(options.maxSubagents === undefined ? {} : { maxSubagents: options.maxSubagents }),
  };
}

type AgentPreferences = Partial<Record<(typeof AGENTS)[number], AgentModelPreference>>;
type AgentModelPreference = {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly custom?: AgentCustomSettings;
};

type AgentCustomSettings = { readonly root?: string; readonly tables?: string };

const AGENT_MANAGED_KEYS = new Set([
  "model",
  "model_reasoning_effort",
  "model_verbosity",
  "service_tier",
]);
const AGENT_BUNDLED_KEYS = new Set(["description", "developer_instructions"]);

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
      if (source.trim() === "") return;
      const managedRoutes =
        previousPlan === undefined
          ? MANAGED_AGENT_MODEL_HISTORY[agent]
          : MANAGED_AGENT_MODEL_HISTORY_BY_PLAN[previousPlan][agent];
      const managed = managedRoutes.some(
        (item) => item.model === model && item.reasoningEffort === reasoningEffort,
      );
      const custom = extractCustomAgentSettings(source);
      if (!managed || custom !== undefined)
        preferences[agent] = {
          ...(model === undefined ? {} : { model }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(custom === undefined ? {} : { custom }),
        };
    }),
  );
  return preferences;
}

async function preserveAgentPreferences(
  root: string,
  preferences: AgentPreferences,
  plan: PlanName,
  fastMode: FastMode,
): Promise<void> {
  await Promise.all(
    AGENTS.map(async (agent) => {
      const preference = preferences[agent];
      if (preference === undefined) return;
      const path = join(root, `${agent}.toml`);
      const route = MODEL_ROUTING_PLANS[plan].agents[agent];
      let source = await readText(path);
      if (preference.custom !== undefined)
        source = mergeCustomAgentSettings(source, preference.custom);
      source = replaceOrAppendTomlString(source, "model", preference.model ?? route.model);
      source = replaceOrAppendTomlString(
        source,
        "model_reasoning_effort",
        preference.reasoningEffort ?? route.reasoningEffort,
      );
      source = replaceOrAppendTomlString(source, "model_verbosity", "low");
      source = replaceOrAppendTomlString(
        source,
        "service_tier",
        fastMode === "standard" ? "default" : "fast",
      );
      await atomicWrite(path, source);
    }),
  );
}

function replaceTomlString(input: string, key: string, value: string): string {
  return input.replace(new RegExp(`^${key}\\s*=.*$`, "m"), `${key} = ${JSON.stringify(value)}`);
}

function replaceOrAppendTomlString(input: string, key: string, value: string): string {
  const replaced = replaceTomlString(input, key, value);
  return replaced === input
    ? `${input.trimEnd()}${input.trimEnd() === "" ? "" : "\n"}${key} = ${JSON.stringify(value)}\n`
    : replaced;
}

function extractCustomAgentSettings(input: string): AgentCustomSettings | undefined {
  const root = input.split(/^\s*\[/m, 1)[0] ?? "";
  const customRoot = root
    .split(/\r?\n/)
    .filter((line) => {
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
      return key !== undefined && !AGENT_MANAGED_KEYS.has(key) && !AGENT_BUNDLED_KEYS.has(key);
    })
    .join("\n");
  const firstTable = input.search(/^\s*\[/m);
  const customTables = firstTable < 0 ? "" : input.slice(firstTable).trim();
  if (customRoot === "" && customTables === "") return undefined;
  return {
    ...(customRoot === "" ? {} : { root: customRoot }),
    ...(customTables === "" ? {} : { tables: customTables }),
  };
}

function mergeCustomAgentSettings(input: string, custom: AgentCustomSettings): string {
  let output = input.trimEnd();
  if (custom.root !== undefined) {
    const firstTable = output.search(/^\s*\[/m);
    const root = firstTable < 0 ? output : output.slice(0, firstTable).trimEnd();
    const tables = firstTable < 0 ? "" : output.slice(firstTable).trimStart();
    output = `${root}\n${custom.root}${tables === "" ? "" : `\n${tables}`}`;
  }
  if (custom.tables !== undefined && !output.includes(custom.tables))
    output = `${output.trimEnd()}\n\n${custom.tables}`;
  return `${output.trimEnd()}\n`;
}

async function writePlatformPlugin(
  root: string,
  platform: NodeJS.Platform,
  plan: PlanName,
  fastMode: FastMode,
): Promise<void> {
  await atomicWrite(
    join(root, ".mcp.json"),
    `${JSON.stringify({ mcpServers: effectiveMcpServers(platform) }, null, 2)}\n`,
  );
  await writeInstalledAgents(join(root, "agents"), platform, plan, fastMode);
}

async function writeInstalledAgents(
  root: string,
  platform: NodeJS.Platform,
  plan: PlanName,
  fastMode: FastMode,
): Promise<void> {
  await Promise.all(
    AGENTS.map(async (agent) => {
      const path = join(root, `${agent}.toml`);
      const route = MODEL_ROUTING_PLANS[plan].agents[agent];
      let source = await readText(path);
      source = replaceTomlString(source, "model", route.model);
      source = replaceTomlString(source, "model_reasoning_effort", route.reasoningEffort);
      source = replaceTomlString(source, "model_verbosity", "low");
      source = replaceOrAppendTomlString(
        source,
        "service_tier",
        fastMode === "standard" ? "default" : "fast",
      );
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
