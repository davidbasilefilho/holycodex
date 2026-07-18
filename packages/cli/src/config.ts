import { Buffer } from "node:buffer";

import { AGENTS, DEFAULT_PLAN, MODEL_ROUTING_PLANS, PLAN_NAMES, type PlanName } from "./catalog.ts";
import { rootTomlStringArray, rootTomlStringArraySource } from "./toml.ts";

const START = "# >>> holycodex managed >>>";
const END = "# <<< holycodex managed <<<";
const ORIGINAL_ROOT = "# holycodex original root: ";
const ORIGINAL_TABLE_KEY = "# holycodex original table key: ";
const PLAN_PREFIX = "# holycodex plan: ";

export type AutonomyMode = "default" | "autonomous" | "dangerous";

const OLD_NAMESPACES = [
  "marketplaces.sisyphuslabs",
  'plugins."omo@sisyphuslabs"',
  "marketplaces.lazycodex",
  'plugins."omo@lazycodex"',
  "marketplaces.code-yeongyu-codex-plugins",
  'plugins."omo@code-yeongyu-codex-plugins"',
  "agents.plan",
  "agents.metis",
  "agents.momus",
  "agents.oracle",
  "agents.sisyphus",
  "agents.prometheus",
  "agents.atlas",
  "agents.hephaestus",
  'hooks.state."omo@sisyphuslabs',
  'hooks.state."omo@lazycodex',
  'hooks.state."omo@code-yeongyu-codex-plugins',
] as const;

/** Removes managed. */
export function removeManaged(input: string): string {
  const escapedStart = START.replaceAll(">", "\\>");
  const escapedEnd = END.replaceAll("<", "\\<");
  return input
    .replace(
      new RegExp(`${escapedStart}([\\s\\S]*?)${escapedEnd}(?:\\r?\\n){0,2}`, "g"),
      (_match, body: string) => {
        const encoded = body.match(/^# holycodex original root: ([A-Za-z0-9+/=]+)$/m)?.[1];
        if (encoded !== undefined) return `${Buffer.from(encoded, "base64").toString("utf8")}\n`;
        const tableKey = body.match(/^# holycodex original table key: ([A-Za-z0-9+/=]+)$/m)?.[1];
        return tableKey === undefined
          ? ""
          : `${Buffer.from(tableKey, "base64").toString("utf8")}\n`;
      },
    )
    .trim();
}

/** Removes legacy omo. */
export function removeLegacyOmo(input: string): string {
  return input
    .split(/(?=^\s*\[)/m)
    .filter((section) => {
      const header = /^\s*\[([^\]]+)]/.exec(section)?.[1];
      if (header === undefined) return true;
      if (
        OLD_NAMESPACES.some(
          (name) =>
            header === name ||
            header.startsWith(`${name}.`) ||
            (name.includes('"omo@') && header.startsWith(name)),
        )
      )
        return false;
      const shared = ["agents.explorer", "agents.librarian", "agents.worker"].some(
        (name) => header === name || header.startsWith(`${name}.`),
      );
      return !shared || !/(?:sisyphuslabs|omo@|oh-my|code-yeongyu)/i.test(section);
    })
    .join("")
    .trimEnd();
}

function injectTableKey(input: string, table: string, key: string, value: string): string {
  const header = new RegExp(`^\\s*\\[${table.replaceAll(".", "\\.")}]\\s*(?:#.*)?$`, "m");
  const match = header.exec(input);
  const tail = match === null ? "" : input.slice(match.index + match[0].length);
  const tableEnd = nextTableBoundary(tail);
  const tableBody = tableEnd < 0 ? tail : tail.slice(0, tableEnd);
  const originalKey = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m").exec(tableBody)?.[0];
  const original =
    originalKey === undefined
      ? ""
      : `${ORIGINAL_TABLE_KEY}${Buffer.from(originalKey).toString("base64")}\n`;
  const managed = `${START}\n${original}${key} = ${value}\n${END}`;
  if (match === null)
    return `${input.trimEnd()}\n\n${START}\n[${table}]\n${key} = ${value}\n${END}`.trim();
  const bodyStart = match.index + match[0].length;
  const next = nextTableBoundary(input.slice(bodyStart));
  const bodyEnd = next < 0 ? input.length : bodyStart + next;
  const cleanedBody = input
    .slice(bodyStart, bodyEnd)
    .replace(new RegExp(`^\\s*${key}\\s*=.*\\r?\\n?`, "gm"), "")
    .trim();
  const suffix = input.slice(bodyEnd).trimStart();
  return `${input.slice(0, bodyStart)}\n${cleanedBody ? `${cleanedBody}\n` : ""}${managed}${suffix ? `\n${suffix}` : ""}`.trim();
}

function nextTableBoundary(input: string): number {
  const header = /^\s*\[/m.exec(input)?.index ?? -1;
  const managedHeader = /^# >>> holycodex managed >>>\r?\n\s*\[/m.exec(input)?.index ?? -1;
  if (header < 0) return managedHeader;
  if (managedHeader < 0) return header;
  return Math.min(header, managedHeader);
}

function rootValue(input: string, key: string): string | undefined {
  if (key === "status_line") return rootTomlStringArraySource(input, key);
  return new RegExp(`^\\s*${key}\\s*=.*$`, "m").exec(input)?.[0];
}

function removeRootValue(input: string, value: string | undefined): string {
  return value === undefined ? input : input.replace(value, "");
}

function rootPreferences(plan: PlanName) {
  const root = MODEL_ROUTING_PLANS[plan].root;
  return [
    ["model", `model = "${root.model}"`],
    ["model_reasoning_effort", `model_reasoning_effort = "${root.reasoningEffort}"`],
    ["model_verbosity", 'model_verbosity = "low"'],
  ] as const;
}

/** Reads the explicitly recorded model routing plan from managed configuration. */
export function readManagedPlan(input: string): PlanName | undefined {
  const value = new RegExp(`^${PLAN_PREFIX}(.+)$`, "m").exec(input)?.[1]?.trim();
  return PLAN_NAMES.find((plan) => plan === value);
}

function preserveManagedRootPreferences(input: string, base: string): string {
  const managedRoot = new RegExp(`^${START}\\r?\\n([\\s\\S]*?)^${END}\\r?$`, "m").exec(input)?.[1];
  if (managedRoot === undefined) return base;
  const previousPlan = readManagedPlan(managedRoot) ?? DEFAULT_PLAN;
  const firstTable = base.search(/^\s*\[/m);
  const root = firstTable < 0 ? base : base.slice(0, firstTable);
  const tables = firstTable < 0 ? "" : base.slice(firstTable);
  let updatedRoot = root.trim();
  for (const [key, fallback] of rootPreferences(previousPlan)) {
    const live = rootValue(managedRoot, key)?.trim();
    const legacy =
      previousPlan === "pro-20x" && key === "model_reasoning_effort"
        ? ['model_reasoning_effort = "xhigh"']
        : [];
    if (
      live === undefined ||
      live === (rootValue(root, key)?.trim() ?? fallback) ||
      legacy.includes(live)
    )
      continue;
    updatedRoot = removeRootValue(updatedRoot, rootValue(updatedRoot, key)).trim();
    updatedRoot = `${updatedRoot}${updatedRoot ? "\n" : ""}${live}`;
  }
  if (updatedRoot === root.trim()) return base;
  return `${updatedRoot}${tables ? `\n${tables.trimStart()}` : ""}`;
}

function mergedStatusLine(original: string | undefined): string {
  if (original === undefined) return '["model-with-reasoning", "context-remaining", "current-dir"]';
  const items = rootTomlStringArray(original, "status_line") ?? [];
  if (!items.includes("context-remaining")) items.push("context-remaining");
  return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
}

/** Installs config. */
export function installConfig(
  input: string,
  mode: AutonomyMode,
  _platform: NodeJS.Platform,
  plan: PlanName = DEFAULT_PLAN,
): string {
  const unmanaged = removeLegacyOmo(removeManaged(input));
  const base = preserveManagedRootPreferences(input, unmanaged);
  const firstTable = base.search(/^\s*\[/m);
  const root = firstTable < 0 ? base : base.slice(0, firstTable);
  const tables = firstTable < 0 ? "" : base.slice(firstTable);
  const controlled = [
    "approval_policy",
    "sandbox_mode",
    "max_concurrent_threads_per_session",
    "status_line",
  ].map((key) => rootValue(root, key));
  const originalRoot = root.trim();
  const preservedRoot = controlled.reduce(removeRootValue, root).trim();
  const hasModel = /^\s*model\s*=/m.test(preservedRoot);
  const hasEffort = /^\s*model_reasoning_effort\s*=/m.test(preservedRoot);
  const hasVerbosity = /^\s*model_verbosity\s*=/m.test(preservedRoot);
  const rootRoute = MODEL_ROUTING_PLANS[plan].root;
  const model = hasModel ? "" : `model = "${rootRoute.model}"\n`;
  const effort = hasEffort ? "" : `model_reasoning_effort = "${rootRoute.reasoningEffort}"\n`;
  const verbosity = hasVerbosity ? "" : 'model_verbosity = "low"\n';
  const approval = mode === "default" ? "on-request" : "never";
  const sandbox = mode === "dangerous" ? "danger-full-access" : "workspace-write";
  const original = originalRoot
    ? `${ORIGINAL_ROOT}${Buffer.from(originalRoot).toString("base64")}\n`
    : "";
  const preserved = preservedRoot ? `${preservedRoot}\n` : "";
  const rootBlock = `${START}\n${PLAN_PREFIX}${plan}\n${original}${model}${effort}${verbosity}${preserved}approval_policy = "${approval}"\nsandbox_mode = "${sandbox}"\nstatus_line = ${mergedStatusLine(controlled[3])}\n${END}`;
  let configured = `${rootBlock}${tables ? `\n\n${tables}` : ""}`;
  configured = injectTableKey(configured, "features", "default_mode_request_user_input", "true");
  configured = injectTableKey(configured, "features", "multi_agent", "true");
  const usage = MODEL_ROUTING_PLANS[plan].usage;
  configured = injectTableKey(configured, "agents", "max_threads", String(usage.maxThreads));
  configured = injectTableKey(configured, "agents", "max_depth", String(usage.maxDepth));
  if (mode !== "dangerous")
    configured = injectTableKey(configured, "sandbox_workspace_write", "network_access", "true");
  for (const agent of AGENTS)
    configured = injectTableKey(
      configured,
      `agents.${agent}`,
      "config_file",
      `"holycodex/agents/${agent}.toml"`,
    );
  const plugin = `${START}\n[marketplaces.holycodex]\nsource = "https://github.com/davidbasilefilho/holycodex.git"\n\n[plugins."holycodex@holycodex"]\nenabled = true\n${END}`;
  return `${configured.trim()}\n\n${plugin}\n`;
}
