import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { CodexAppServerClient, WorkflowManager } from "@holycodex/workflow-host";
import type { JsonValue } from "@holycodex/workflow-runtime";
import { runWorkflowInSubprocess } from "@holycodex/workflow-runtime/subprocess";

import {
  DEFAULT_PLAN,
  FastModeSchema,
  MODEL_ROUTING_PLANS,
  PlanNameSchema,
  type PlanName,
} from "./catalog.ts";

const HELP = `HolyCodex dynamic workflows

Usage:
  workflow run <script.js> [args.json] [--trusted]
  workflow list
  workflow show <run-id>
  workflow pause <run-id>
  workflow resume <run-id>
  workflow stop-agent <run-id> <call-id>
  workflow stop <run-id>
  workflow restart <run-id>
  workflow reopen <run-id>
  workflow save <user|project> <name> <script.js> [--trusted]
  workflow invoke <user|project> <name> [args.json] [--trusted]

Output is JSON. Project execution and project-saved workflows require --trusted,
which may be supplied only after Codex establishes project trust.
`;

type WorkflowCommand =
  | "run"
  | "list"
  | "show"
  | "pause"
  | "resume"
  | "stop-agent"
  | "stop"
  | "restart"
  | "reopen"
  | "save"
  | "invoke";

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "--help" || raw[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const trusted = raw.includes("--trusted");
  const args = raw.filter((value) => value !== "--trusted");
  const command = parseCommand(args.shift());
  const config = await installedConfiguration();
  const plan = readPlan(config);
  const fast = readFast(config);
  const preset = MODEL_ROUTING_PLANS[plan];
  const serviceTier = fast === "standard" ? "default" : "fast";
  const projectPath = process.cwd();
  const codexExecutable = process.env.HOLYCODEX_CODEX_COMMAND ?? "codex";
  const manager = new WorkflowManager({
    storageDir: join(homedir(), ".codex", "holycodex", "workflow-runs"),
    userSavedDir: join(homedir(), ".codex", "workflows"),
    projectSavedDir: join(projectPath, ".codex", "workflows"),
    projectPath,
    trusted,
    plan,
    planLimits: {
      maxCalls: preset.workflow.limits.totalCalls,
      maxConcurrency: preset.workflow.limits.concurrency,
      maxRetries: preset.workflow.limits.retries,
      maxFanOut: preset.workflow.limits.fanOut,
      maxLoopIterations: preset.workflow.limits.loopIterations,
      maxRuntimeMs: preset.workflow.runtime.maxRuntimeMs,
      maxScriptBytes: preset.workflow.softSizeGuidance.maxScriptBytes,
    },
    clientFactory: () =>
      new CodexAppServerClient({
        executable: codexExecutable,
        args: ["app-server"],
        cwd: projectPath,
      }),
    policy: { cwd: projectPath, lowVerbosity: true },
    runner: async (input) =>
      await runWorkflowInSubprocess(input, {
        executable: process.execPath,
        workerPath: join(import.meta.dirname, "workflow-evaluator.js"),
      }),
  });
  const routes = Object.fromEntries([
    ...Object.entries(preset.agents).map(([agent, route]) => [agent, { ...route, serviceTier }]),
    ...Object.entries(preset.workflow.permittedRoutes).flatMap(([agent, stages]) =>
      Object.entries(stages).map(([stage, [route]]) => [
        `${agent}:${stage}`,
        { ...route, serviceTier },
      ]),
    ),
  ]);
  const permittedRoutes = Object.fromEntries(
    Object.entries(preset.workflow.permittedRoutes).map(([agent, stages]) => [
      agent,
      [
        ...new Map(
          Object.values(stages)
            .flat()
            .map((route) => [JSON.stringify(route), route]),
        ).values(),
      ],
    ]),
  );
  const result = await execute(
    command,
    args,
    manager,
    routes,
    permittedRoutes,
    trusted,
    projectPath,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function execute(
  command: WorkflowCommand,
  args: readonly string[],
  manager: WorkflowManager,
  routes: Readonly<Record<string, { model: string; reasoningEffort: string; serviceTier: string }>>,
  permittedRoutes: Readonly<Record<string, readonly { model: string; reasoningEffort: string }[]>>,
  trusted: boolean,
  projectPath: string,
): Promise<unknown> {
  if (command === "list")
    return (await manager.list()).map(
      ({ script: _script, completed: _completed, ...journal }) => journal,
    );
  if (command === "show" || command === "reopen")
    return inspection(await manager.reopen(required(args, 0)));
  if (command === "pause") return await manager.pause(required(args, 0));
  if (command === "resume") return await manager.resume(required(args, 0));
  if (command === "stop-agent")
    return await manager.stopAgent(required(args, 0), required(args, 1));
  if (command === "stop") return await manager.stopRun(required(args, 0));
  if (command === "restart") return await manager.restartFailed(required(args, 0));
  if (command === "save") {
    const scope = parseScope(required(args, 0));
    enforceProjectTrust(scope, trusted);
    return {
      path: await manager.save(required(args, 1), await readFile(required(args, 2), "utf8"), scope),
    };
  }
  if (command === "invoke") {
    const scope = parseScope(required(args, 0));
    enforceProjectTrust(scope, trusted);
    return await manager.invokeSaved(required(args, 1), await optionalJson(args[2]), scope, {
      routes,
      permittedRoutes,
      policy: { cwd: projectPath, lowVerbosity: true },
    });
  }
  const scriptPath = resolve(required(args, 0));
  const invocationArgs = await optionalJson(args[1]);
  return await manager.run({
    script: await readFile(scriptPath, "utf8"),
    ...(invocationArgs === undefined ? {} : { args: invocationArgs }),
    meta: { source: basename(scriptPath) },
    projectPath,
    trusted,
    routes,
    permittedRoutes,
    policy: { cwd: projectPath, lowVerbosity: true },
  });
}

function parseCommand(value: string | undefined): WorkflowCommand {
  const commands = new Set<WorkflowCommand>([
    "run",
    "list",
    "show",
    "pause",
    "resume",
    "stop-agent",
    "stop",
    "restart",
    "reopen",
    "save",
    "invoke",
  ]);
  if (value === undefined || !commands.has(value as WorkflowCommand))
    throw new Error(`Unknown workflow command: ${value ?? ""}`);
  return value as WorkflowCommand;
}

function required(args: readonly string[], index: number): string {
  const value = args[index];
  if (value === undefined) throw new Error("Missing workflow command argument.");
  return value;
}

function parseScope(value: string): "user" | "project" {
  if (value !== "user" && value !== "project") throw new Error(`Unknown workflow scope: ${value}`);
  return value;
}

function enforceProjectTrust(scope: "user" | "project", trusted: boolean): void {
  if (scope === "project" && !trusted) throw new Error("Project workflow scope requires trust.");
}

async function optionalJson(path: string | undefined): Promise<JsonValue | undefined> {
  if (path === undefined) return undefined;
  return JSON.parse(await readFile(resolve(path), "utf8")) as JsonValue;
}

async function installedConfiguration(): Promise<string> {
  try {
    return await readFile(join(homedir(), ".codex", "config.toml"), "utf8");
  } catch {
    return "";
  }
}

function readPlan(config: string): PlanName {
  const value = config.match(/^# holycodex plan: (.+)$/m)?.[1];
  return PlanNameSchema.catch(DEFAULT_PLAN).parse(value);
}

function readFast(config: string): "standard" | "fast" | "fast-all" {
  const value = config.match(/^# holycodex fast: (.+)$/m)?.[1];
  return FastModeSchema.catch("standard").parse(value);
}

function inspection(journal: Awaited<ReturnType<WorkflowManager["reopen"]>>): unknown {
  const {
    args: _args,
    completed,
    policy: _policy,
    route: _route,
    routes: _routes,
    ...publicState
  } = journal;
  return {
    ...publicState,
    completedResults: Object.values(completed).map(({ result, usage }) => ({ result, usage })),
  };
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Workflow command failed."}\n`);
  process.exitCode = 1;
}
