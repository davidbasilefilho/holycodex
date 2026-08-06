import { Buffer } from "node:buffer";

import {
  AGENTS,
  DEFAULT_PLAN,
  FastModeSchema,
  type FastMode,
  MANAGED_ROOT_MODEL_HISTORY_BY_PLAN,
  MODEL_ROUTING_PLANS,
  PLAN_NAMES,
  type PlanName,
  type WorkflowLimits,
} from "./catalog.ts";
import {
  AUTONOMY_METADATA_PREFIX,
  inferAutonomyMode,
  normalizeRequestedAutonomy,
  originalPermissionMetadata,
  permissionSelectionForMode,
  permissionSelectionMatchesMode,
  permissionSelectionsEqual,
  readAutonomyMetadata,
  readOriginalPermissionMetadata,
  readPermissionLines,
  readRawPermissionSelection,
  removePermissionLines,
  selectPermissionSelection,
  type AutonomyMode,
  type RequestedAutonomy,
} from "./permission-selection.ts";
import { rootTomlString, rootTomlStringArray, rootTomlStringArraySource } from "./toml.ts";

const START = "# >>> holycodex managed >>>";
const END = "# <<< holycodex managed <<<";
const ORIGINAL_ROOT = "# holycodex original root: ";
const ORIGINAL_TABLE_KEY = "# holycodex original table key: ";
const PLAN_PREFIX = "# holycodex plan: ";
const FAST_MODE_PREFIX = "# holycodex fast: ";
const MAX_SUBAGENTS_PREFIX = "# holycodex max-subagents: ";
const WORKFLOW_POLICY_PREFIX = "# holycodex workflow-policy: ";

export type { AutonomyMode, RequestedAutonomy } from "./permission-selection.ts";
export type ManagedMaxSubagents =
  | { readonly configured: false }
  | { readonly configured: true; readonly value?: number };

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

function readOriginalRootMetadata(input: string): string | undefined {
  const encoded = input.match(/^# holycodex original root: ([A-Za-z0-9+/=]+)$/m)?.[1];
  return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
}

function readLegacyGeneratedRoot(input: string): string | undefined {
  const body = input.match(
    /^# >>> holycodex managed >>>\r?\n([\s\S]*?)^# <<< holycodex managed <<</m,
  )?.[1];
  if (body === undefined || readPermissionLines(body).length === 0) return undefined;
  return inferAutonomyMode(readRawPermissionSelection(body)) === "custom" ? undefined : body;
}

/** Removes managed configuration and restores durable original values. */
export function removeManaged(input: string, preserveGeneratedPermissions = false): string {
  const escapedStart = START.replaceAll(">", "\\>");
  const escapedEnd = END.replaceAll("<", "\\<");
  return input
    .replace(
      new RegExp(`${escapedStart}([\\s\\S]*?)${escapedEnd}(?:\\r?\\n){0,2}`, "g"),
      (_match, body: string) => {
        const original = readOriginalRootMetadata(body);
        const originalPermissions = readOriginalPermissionMetadata(body);
        const currentPermissions = readPermissionLines(body);
        const currentSelection = readRawPermissionSelection(body);
        const metadata = readAutonomyMetadata(body);
        const expected =
          metadata === undefined || metadata === "custom"
            ? originalPermissions === undefined
              ? undefined
              : readRawPermissionSelection(originalPermissions.join("\n"))
            : permissionSelectionForMode(metadata);
        const generated =
          metadata !== undefined && metadata !== "custom"
            ? permissionSelectionMatchesMode(currentSelection, metadata)
            : expected !== undefined
              ? permissionSelectionsEqual(currentSelection, expected)
              : metadata === undefined &&
                ["default", "autonomous", "dangerous"].some((mode) =>
                  permissionSelectionMatchesMode(currentSelection, mode as AutonomyMode),
                );
        const preserveCurrent = preserveGeneratedPermissions || !generated;
        if (original !== undefined) {
          const restored = preserveCurrent
            ? `${removePermissionLines(original)}${
                currentPermissions.length === 0 ? "" : `\n${currentPermissions.join("\n")}`
              }`.trim()
            : `${removePermissionLines(original)}${
                (originalPermissions ?? readPermissionLines(original)).length === 0
                  ? ""
                  : `\n${(originalPermissions ?? readPermissionLines(original)).join("\n")}`
              }`.trim();
          return `${restored}\n`;
        }
        if (!preserveCurrent && originalPermissions !== undefined)
          return `${originalPermissions.join("\n")}\n`;
        if (preserveCurrent && currentPermissions.length > 0)
          return `${currentPermissions.join("\n")}\n`;
        const tableKeys = [
          ...body.matchAll(/^# holycodex original table key: ([A-Za-z0-9+/=]+)$/gm),
        ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
        return tableKeys.length === 0
          ? ""
          : `${tableKeys.map((key) => Buffer.from(key, "base64").toString("utf8")).join("\n")}\n`;
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

type TableEntry = readonly [key: string, value: string];

function injectTableKeys(input: string, table: string, entries: readonly TableEntry[]): string {
  const header = new RegExp(`^\\s*\\[${table.replaceAll(".", "\\.")}]\\s*(?:#.*)?$`, "m");
  const match = header.exec(input);
  const tail = match === null ? "" : input.slice(match.index + match[0].length);
  const tableEnd = nextTableBoundary(tail);
  const tableBody = tableEnd < 0 ? tail : tail.slice(0, tableEnd);
  const original = entries
    .map(([key]) => new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m").exec(tableBody)?.[0])
    .filter((value): value is string => value !== undefined)
    .map((value) => `${ORIGINAL_TABLE_KEY}${Buffer.from(value).toString("base64")}\n`)
    .join("");
  const managed = `${START}\n${original}${entries.map(([key, value]) => `${key} = ${value}`).join("\n")}\n${END}`;
  if (match === null)
    return `${input.trimEnd()}\n\n${START}\n[${table}]\n${entries.map(([key, value]) => `${key} = ${value}`).join("\n")}\n${END}`.trim();
  const bodyStart = match.index + match[0].length;
  const next = nextTableBoundary(input.slice(bodyStart));
  const bodyEnd = next < 0 ? input.length : bodyStart + next;
  const cleanedBody = entries
    .reduce(
      (body, [key]) => body.replace(new RegExp(`^\\s*${key}\\s*=.*\\r?\\n?`, "gm"), ""),
      input.slice(bodyStart, bodyEnd),
    )
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

function tableSource(input: string, table: string): string | undefined {
  const match = new RegExp(`^\\s*\\[${table.replaceAll(".", "\\.")}]\\s*(?:#.*)?$`, "m").exec(
    input,
  );
  if (match === null) return undefined;
  const tail = input.slice(match.index + match[0].length);
  const end = nextTableBoundary(tail);
  return end < 0 ? tail : tail.slice(0, end);
}

function rootValue(input: string, key: string): string | undefined {
  if (key === "status_line") return rootTomlStringArraySource(input, key);
  return new RegExp(`^\\s*${key}\\s*=.*$`, "m").exec(input)?.[0];
}

function removeRootValue(input: string, value: string | undefined): string {
  return value === undefined ? input : input.replace(value, "");
}

function removeRootKey(input: string, key: string): string {
  let updated = input;
  for (;;) {
    const value = rootValue(updated, key);
    if (value === undefined) return updated;
    updated = removeRootValue(updated, value);
  }
}

/** Reads the explicitly recorded model routing plan from managed configuration. */
export function readManagedPlan(input: string): PlanName | undefined {
  const value = new RegExp(`^${PLAN_PREFIX}(.+)$`, "m").exec(input)?.[1]?.trim();
  return PLAN_NAMES.find((plan) => plan === value);
}

/** Reads the explicitly recorded managed Fast mode. */
export function readManagedFastMode(input: string): FastMode | undefined {
  const value = new RegExp(`^${FAST_MODE_PREFIX}(.+)$`, "m").exec(input)?.[1]?.trim();
  return FastModeSchema.safeParse(value).data;
}

/** Reads an explicit managed direct-subagent override. */
export function readManagedMaxSubagents(input: string): ManagedMaxSubagents {
  const raw = new RegExp(`^${MAX_SUBAGENTS_PREFIX}(.*)$`, "m").exec(input)?.[1]?.trim();
  if (raw === undefined) return { configured: false };
  if (!/^\d+$/.test(raw)) return { configured: true };
  return { configured: true, value: Number(raw) };
}

export type ManagedWorkflowPolicy = {
  readonly plan: PlanName;
  readonly limits: WorkflowLimits;
  readonly projectedUsage: { readonly standard: number; readonly fast: number };
  readonly softSizeGuidance: { readonly maxInputTokens: number };
};

/** Reads the plan-authoritative workflow policy metadata from managed configuration. */
export function readManagedWorkflowPolicy(input: string): ManagedWorkflowPolicy | undefined {
  const raw = new RegExp(
    `^${WORKFLOW_POLICY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(.+)$`,
    "m",
  ).exec(input)?.[1];
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const plan = PLAN_NAMES.find((name) => name === record.plan);
    const limits = record.limits;
    const usage = record.projectedUsage;
    const size = record.softSizeGuidance;
    if (
      plan === undefined ||
      typeof limits !== "object" ||
      limits === null ||
      typeof usage !== "object" ||
      usage === null ||
      typeof size !== "object" ||
      size === null
    )
      return undefined;
    return {
      plan,
      limits: limits as WorkflowLimits,
      projectedUsage: usage as ManagedWorkflowPolicy["projectedUsage"],
      softSizeGuidance: size as ManagedWorkflowPolicy["softSizeGuidance"],
    };
  } catch {
    return undefined;
  }
}

type RootModelOverrides = {
  readonly model: boolean;
  readonly reasoningEffort: boolean;
  readonly webSearch: boolean;
};

/** Identifies explicit Root route overrides preserved from active managed configuration. */
export function readPreservedRootOverrides(input: string): RootModelOverrides {
  const managedRoot = new RegExp(`^${START}\\r?\\n([\\s\\S]*?)^${END}\\r?$`, "m").exec(input)?.[1];
  if (managedRoot === undefined) return { model: false, reasoningEffort: false, webSearch: false };
  const plan = readManagedPlan(managedRoot);
  const model = rootTomlString(input, "model");
  const reasoningEffort = rootTomlString(input, "model_reasoning_effort");
  if (plan === undefined || model === undefined || reasoningEffort === undefined)
    return { model: false, reasoningEffort: false, webSearch: false };
  const managed = MANAGED_ROOT_MODEL_HISTORY_BY_PLAN[plan].some(
    (route) => route.model === model && route.reasoningEffort === reasoningEffort,
  );
  if (managed)
    return {
      model: false,
      reasoningEffort: false,
      webSearch: rootTomlString(managedRoot, "web_search") !== "live",
    };
  const preset = MODEL_ROUTING_PLANS[plan].root;
  return {
    model: model !== preset.model,
    reasoningEffort: reasoningEffort !== preset.reasoningEffort,
    webSearch: rootTomlString(managedRoot, "web_search") !== "live",
  };
}

function preserveManagedRootPreferences(input: string, base: string): string {
  const managedRoot = new RegExp(`^${START}\\r?\\n([\\s\\S]*?)^${END}\\r?$`, "m").exec(input)?.[1];
  if (managedRoot === undefined) return base;
  const firstTable = base.search(/^\s*\[/m);
  const root = firstTable < 0 ? base : base.slice(0, firstTable);
  const tables = firstTable < 0 ? "" : base.slice(firstTable);
  let updatedRoot = root.trim();
  const overrides = readPreservedRootOverrides(input);
  for (const [key, preserve] of [
    ["model", overrides.model],
    ["model_reasoning_effort", overrides.reasoningEffort],
    ["web_search", overrides.webSearch],
  ] as const) {
    const live = rootValue(managedRoot, key)?.trim();
    if (!preserve || live === undefined) continue;
    if (rootValue(root, key)?.trim() === live) continue;
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
  mode: AutonomyMode | RequestedAutonomy | undefined,
  _platform: NodeJS.Platform,
  plan: PlanName = DEFAULT_PLAN,
  maxSubagents?: number,
  fastMode: FastMode = "standard",
): string {
  const request = normalizeRequestedAutonomy(mode);
  const priorAutonomy = readAutonomyMetadata(input);
  const previousOriginalRoot = readOriginalRootMetadata(input);
  const legacyGeneratedRoot = readLegacyGeneratedRoot(input);
  const originalPermissionLines = readOriginalPermissionMetadata(input);
  const unmanaged = removeLegacyOmo(removeManaged(input, !request.requested));
  const base = preserveManagedRootPreferences(input, unmanaged);
  const firstTable = base.search(/^\s*\[/m);
  const root = firstTable < 0 ? base : base.slice(0, firstTable);
  const tables = firstTable < 0 ? "" : base.slice(firstTable);
  const livePermissions = readRawPermissionSelection(root);
  const permissions = selectPermissionSelection(livePermissions, request);
  const effectiveAutonomy = request.requested
    ? inferAutonomyMode(permissions)
    : (priorAutonomy ?? inferAutonomyMode(permissions));
  const rootPermissionLines = [
    permissions.approvalPolicy === undefined
      ? undefined
      : `approval_policy = ${JSON.stringify(permissions.approvalPolicy)}`,
    permissions.approvalsReviewer === undefined
      ? undefined
      : `approvals_reviewer = ${JSON.stringify(permissions.approvalsReviewer)}`,
    permissions.sandboxMode === undefined
      ? undefined
      : `sandbox_mode = ${JSON.stringify(permissions.sandboxMode)}`,
  ].filter((line): line is string => line !== undefined);
  const hadManagedAutonomy = readAutonomyMetadata(input) !== undefined;
  const hadOriginalRoot = /^# holycodex original root:/m.test(input);
  const permissionLines =
    originalPermissionLines ??
    (legacyGeneratedRoot !== undefined && previousOriginalRoot === undefined
      ? []
      : previousOriginalRoot === undefined
        ? hadManagedAutonomy && !hadOriginalRoot
          ? []
          : readPermissionLines(root)
        : readPermissionLines(previousOriginalRoot));
  const controlled = [
    "web_search",
    "approval_policy",
    "approvals_reviewer",
    "sandbox_mode",
    "max_concurrent_threads_per_session",
    "status_line",
    "model_verbosity",
    "service_tier",
    ...(request.requested ? ["default_permissions"] : []),
  ].map((key) => rootValue(root, key));
  const controlledKeys = [
    "web_search",
    "approval_policy",
    "approvals_reviewer",
    "sandbox_mode",
    "max_concurrent_threads_per_session",
    "status_line",
    "model_verbosity",
    "service_tier",
    ...(request.requested ? ["default_permissions"] : []),
  ];
  const preservedRoot = controlledKeys.reduce(removeRootKey, root).trim();
  const originalControlled = controlled
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => root.indexOf(left) - root.indexOf(right))
    .join("\n");
  const hasModel = /^\s*model\s*=/m.test(preservedRoot);
  const hasEffort = /^\s*model_reasoning_effort\s*=/m.test(preservedRoot);
  const rootRoute = MODEL_ROUTING_PLANS[plan].root;
  const model = hasModel ? "" : `model = "${rootRoute.model}"\n`;
  const effort = hasEffort ? "" : `model_reasoning_effort = "${rootRoute.reasoningEffort}"\n`;
  const originalSource =
    previousOriginalRoot === undefined
      ? priorAutonomy === undefined && legacyGeneratedRoot === undefined
        ? originalControlled
        : ""
      : removePermissionLines(previousOriginalRoot);
  const original = originalSource
    ? `${ORIGINAL_ROOT}${Buffer.from(originalSource).toString("base64")}\n`
    : "";
  const rootServiceTier = fastMode === "fast-all" ? "fast" : "default";
  const priorManagedRoot = new RegExp(`^${START}\\r?\\n([\\s\\S]*?)^${END}\\r?$`, "m").exec(
    input,
  )?.[1];
  const webSearch = readPreservedRootOverrides(input).webSearch
    ? (rootTomlString(priorManagedRoot ?? "", "web_search") ?? "live")
    : "live";
  const statusLine = mergedStatusLine(
    rootValue(root, "status_line") ??
      rootTomlStringArraySource(tableSource(base, "tui") ?? "", "status_line"),
  );
  const workflow = MODEL_ROUTING_PLANS[plan].workflow;
  const workflowMetadata = JSON.stringify({
    plan,
    limits: workflow.limits,
    projectedUsage: workflow.projectedUsage,
    softSizeGuidance: workflow.softSizeGuidance,
  });
  const rootBlock = `${START}\n${PLAN_PREFIX}${plan}\n${FAST_MODE_PREFIX}${fastMode}\n${WORKFLOW_POLICY_PREFIX}${workflowMetadata}\n${AUTONOMY_METADATA_PREFIX}${effectiveAutonomy}\n${original}${originalPermissionMetadata(permissionLines)}${model}${effort}web_search = ${JSON.stringify(webSearch)}\nmodel_verbosity = "low"\nservice_tier = "${rootServiceTier}"\n${rootPermissionLines.join("\n")}\n${END}`;
  let configured = `${preservedRoot ? `${preservedRoot}\n` : ""}${rootBlock}${tables ? `\n\n${tables}` : ""}`;
  const legacyMultiAgentV2 = /\bmulti_agent_v2\s*=\s*(true|false)/.exec(configured)?.[1];
  configured = injectTableKeys(configured, "features", [
    ["default_mode_request_user_input", "true"],
    ["multi_agent", "true"],
    ...(legacyMultiAgentV2 === undefined ? [] : [["multi_agent_v2", legacyMultiAgentV2] as const]),
  ]);
  configured = injectTableKeys(configured, "agents", [
    [
      "max_concurrent_threads_per_session",
      String((maxSubagents ?? workflow.limits.concurrency) + 1),
    ],
  ]);
  configured = injectTableKeys(configured, "tui", [["status_line", statusLine]]);
  if (effectiveAutonomy !== "dangerous")
    configured = injectTableKeys(configured, "sandbox_workspace_write", [
      ["network_access", "true"],
    ]);
  configured = injectTableKeys(configured, "desktop", [["show-context-window-usage", "true"]]);
  if (_platform === "win32")
    configured = injectTableKeys(configured, "windows", [["sandbox", '"unelevated"']]);
  for (const agent of AGENTS)
    configured = injectTableKeys(configured, `agents.${agent}`, [
      ["config_file", `"holycodex/agents/${agent}.toml"`],
    ]);
  const plugin = `${START}\n[plugins."holycodex@holycodex"]\nenabled = true\n${END}`;
  return `${configured.trim()}\n\n${plugin}\n`;
}
