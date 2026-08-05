import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { pluginRoot } from "@holycodex/plugin";

import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../../git-bash/src/git-bash-resolver.ts";
import { runManagedProcess } from "../../runtime-core/src/process.ts";
import {
  AGENTS,
  CONTEXT7_POLICY,
  DEFAULT_PLAN,
  MANAGED_AGENT_MODEL_HISTORY,
  MANAGED_AGENT_MODEL_HISTORY_BY_PLAN,
  LITE_WRITING_POLICY,
  MODEL_ROUTING_PLANS,
  type FastMode,
  type PlanName,
  VERSION,
  WINDOWS_SHELL_POLICY,
} from "./catalog.ts";
import {
  installComputerUse,
  installCodexSecurity,
  type CodexProcessRunner,
  type CodexSecurityInstallResult,
} from "./codex-security.ts";
import {
  installConfig,
  readManagedPlan,
  removeManaged,
  type AutonomyMode,
  type RequestedAutonomy,
} from "./config.ts";
import { atomicWrite, backup, exists, readText } from "./files.ts";
import { rootTomlString } from "./toml.ts";

export type RunOptions = {
  readonly autonomy?: AutonomyMode | RequestedAutonomy;
  readonly fast?: FastMode;
  readonly json: boolean;
  readonly plan?: PlanName;
  readonly maxSubagents?: number;
  readonly verbose?: boolean;
  readonly onProgress?: (event: InstallProgressEvent) => void;
};
export type InstallProgressEvent = {
  readonly step: string;
  readonly label: string;
  readonly status: "running" | "complete";
  readonly detail?: string;
};
export type RunResult = {
  readonly action: "install" | "cleanup";
  readonly changed: readonly string[];
  readonly backups: readonly string[];
  readonly plan?: PlanName;
  readonly codexSecurity?: CodexSecurityInstallResult;
  readonly computerUse?: CodexSecurityInstallResult;
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
const BACKUP_RETENTION = 5;

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
  notify(options, "prerequisites", "Checking prerequisites", "running");
  assertGitBashReady(runtime.platform, runtime.gitBash());
  notify(options, "prerequisites", "Checking prerequisites", "complete");
  const plan = options.plan ?? DEFAULT_PLAN;
  const target = paths();
  const root = backupRoot();
  notify(options, "backup", "Backing up existing installation", "running");
  const configBackup = await backup(target.config, root);
  const cacheBackup = await backup(target.marketplaceCache, root);
  const agentsBackup = await backup(target.agents, root);
  const backups = [
    configBackup,
    cacheBackup,
    agentsBackup,
    ...(await Promise.all(target.legacy.map((path) => backup(path, root)))),
  ].filter((path) => path !== undefined);
  notify(
    options,
    "backup",
    "Backing up existing installation",
    "complete",
    `${backups.length} saved`,
  );
  notify(options, "configuration", "Preparing configuration", "running");
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
  notify(options, "configuration", "Preparing configuration", "complete", plan);
  notify(options, "staging", "Staging plugin and agent files", "running");
  const existingAgentPreferences = await readAgentPreferences(target.agents, previousPlan);
  const staging = await mkdtemp(join(tmpdir(), "holycodex-stage-"));
  const stagedCache = join(staging, "cache");
  const stagedAgents = join(staging, "agents");
  await cp(pluginRoot, stagedCache, { recursive: true });
  await writeInstalledAgents(join(stagedCache, "agents"), runtime.platform, plan, fastMode);
  await cp(join(pluginRoot, "agents"), stagedAgents, { recursive: true });
  await writeInstalledAgents(stagedAgents, runtime.platform, plan, fastMode);
  await preserveAgentPreferences(stagedAgents, existingAgentPreferences, plan, fastMode);
  notify(options, "staging", "Staging plugin and agent files", "complete");
  notify(options, "validation", "Validating staged installation", "running");
  await validateStaging(stagedCache, stagedAgents);
  notify(options, "validation", "Validating staged installation", "complete");
  const removedLegacy: string[] = [];
  let codexSecurity: CodexSecurityInstallResult | undefined;
  let computerUse: CodexSecurityInstallResult | undefined;
  try {
    notify(options, "managed-files", "Installing managed files", "running");
    await atomicWrite(target.config, config);
    await rm(target.cache, { recursive: true, force: true });
    await mkdir(dirname(target.cache), { recursive: true });
    await cp(stagedCache, target.cache, { recursive: true });
    await rm(target.agents, { recursive: true, force: true });
    await cp(stagedAgents, target.agents, { recursive: true });
    for (const path of target.legacy) {
      if (!(await exists(path))) continue;
      await rm(path, { recursive: true });
      removedLegacy.push(path);
    }
    notify(options, "managed-files", "Installing managed files", "complete");
    notify(options, "codex-security", "Installing Codex Security", "running");
    codexSecurity = await installCodexSecurity(runtime.runProcess, runtime.platform, process.env);
    notify(
      options,
      "codex-security",
      "Installing Codex Security",
      "complete",
      pluginProgressDetail(codexSecurity),
    );
    notify(options, "computer-use", "Installing Computer Use", "running");
    computerUse = await installComputerUse(runtime.runProcess, runtime.platform, process.env);
    notify(
      options,
      "computer-use",
      "Installing Computer Use",
      "complete",
      pluginProgressDetail(computerUse),
    );
    notify(options, "cleanup", "Removing obsolete caches", "running");
    await removeObsoleteVersionCaches(target.cacheRoot);
    notify(options, "cleanup", "Removing obsolete caches", "complete");
  } catch (error) {
    await restoreTarget(target.config, configBackup);
    await restoreTarget(target.marketplaceCache, cacheBackup);
    await restoreTarget(target.agents, agentsBackup);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await pruneBackupHistory();
  return {
    action: "install",
    changed: [target.config, target.cache, target.agents, ...removedLegacy],
    backups,
    plan,
    codexSecurity,
    computerUse,
  };
}

function notify(
  options: RunOptions,
  step: string,
  label: string,
  status: InstallProgressEvent["status"],
  detail?: string,
): void {
  options.onProgress?.({ step, label, status, ...(detail === undefined ? {} : { detail }) });
}

function pluginProgressDetail(result: CodexSecurityInstallResult): string {
  if (result.status === "skipped") return `skipped: ${result.reason}`;
  return result.launcherSource === undefined
    ? result.status
    : `${result.status} via ${result.launcherSource}`;
}

async function validateStaging(cache: string, agents: string): Promise<void> {
  const required = [
    join(cache, ".codex-plugin", "plugin.json"),
    join(cache, "skills", "context7-cli", "SKILL.md"),
    join(cache, "runtime", "lsp.js"),
    ...AGENTS.map((agent) => join(agents, `${agent}.toml`)),
  ];
  const missing = [];
  for (const path of required) if (!(await exists(path))) missing.push(path);
  if (missing.length > 0)
    throw new Error(`Staged HolyCodex installation is incomplete: ${missing.join(", ")}`);
}

async function restoreTarget(target: string, source: string | undefined): Promise<void> {
  await rm(target, { recursive: true, force: true });
  if (source !== undefined) await cp(source, target, { recursive: true });
}

async function removeObsoleteVersionCaches(cacheRoot: string): Promise<void> {
  if (!(await exists(cacheRoot))) return;
  for (const entry of await readdir(cacheRoot))
    if (entry !== VERSION) await rm(join(cacheRoot, entry), { recursive: true, force: true });
}

async function pruneBackupHistory(): Promise<void> {
  const root = join(tmpdir(), "holycodex-backups");
  if (!(await exists(root))) return;
  const entries = (await readdir(root)).sort().reverse();
  await Promise.allSettled(
    entries
      .slice(BACKUP_RETENTION, BACKUP_RETENTION + 1)
      .map((entry) => rm(join(root, entry), { recursive: true, force: true })),
  );
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
  const hasRootAssignment = rootTomlString(input, key) !== undefined;
  const replaced = replaceTomlString(input, key, value);
  return hasRootAssignment
    ? replaced
    : `${input.trimEnd()}${input.trimEnd() === "" ? "" : "\n"}${key} = ${JSON.stringify(value)}\n`;
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
      source = composeAgentPolicies(source, platform);
      source = replaceTomlString(source, "model", route.model);
      source = replaceTomlString(source, "model_reasoning_effort", route.reasoningEffort);
      source = replaceTomlString(source, "model_verbosity", "low");
      source = replaceOrAppendTomlString(
        source,
        "service_tier",
        fastMode === "standard" ? "default" : "fast",
      );
      await atomicWrite(path, source);
    }),
  );
}

function composeAgentPolicies(input: string, platform: NodeJS.Platform): string {
  const policy = [
    LITE_WRITING_POLICY,
    CONTEXT7_POLICY,
    ...(platform === "win32" ? [WINDOWS_SHELL_POLICY] : []),
  ].join("\n\n");
  return input.replace(/(developer_instructions\s*=\s*"""\r?\n)/, `$1${policy}\n\n`);
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
