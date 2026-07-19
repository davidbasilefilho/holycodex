import { z } from "zod";

import { codexSlimEditInvocation, type PackageRunner } from "./package-runner.ts";

export const VERSION = "0.7.4";

export const SKILLS = [
  "ast-grep",
  "caveman",
  "compress",
  "debugging",
  "define-goal",
  "frontend",
  "handoff",
  "lsp",
  "lsp-setup",
  "plan",
  "plan-review",
  "programming",
  "refactor",
  "remove-slop",
  "rules",
  "security-research",
] as const;

export const AgentNameSchema = z.enum(["explorer", "librarian", "worker"]);
export const AGENTS = AgentNameSchema.options;
export type AgentName = z.infer<typeof AgentNameSchema>;

export const PlanNameSchema = z.enum(["go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"]);
export const PLAN_NAMES = PlanNameSchema.options;
export type PlanName = z.infer<typeof PlanNameSchema>;

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

const ModelRouteSchema = z.discriminatedUnion("model", [
  z.strictObject({
    model: z.literal("gpt-5.6-luna"),
    reasoningEffort: z.enum(["low", "medium", "high"]),
  }),
  z.strictObject({
    model: z.literal("gpt-5.6-terra"),
    reasoningEffort: z.enum(["low", "medium", "high"]),
  }),
  z.strictObject({
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
  }),
]);
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

const RoutingPresetSchema = z.strictObject({
  root: ModelRouteSchema,
  agents: z.strictObject({
    explorer: ModelRouteSchema,
    librarian: ModelRouteSchema,
    worker: ModelRouteSchema,
  }),
  usage: z.strictObject({
    maxThreads: z.union([z.literal(1), z.literal(2)]),
    maxDepth: z.literal(1),
  }),
});
export type RoutingPreset = z.infer<typeof RoutingPresetSchema>;

export const ModelRoutingPlansSchema = z.strictObject({
  go: RoutingPresetSchema,
  "plus-low": RoutingPresetSchema,
  plus: RoutingPresetSchema,
  "plus-high": RoutingPresetSchema,
  "pro-5x": RoutingPresetSchema,
  "pro-20x": RoutingPresetSchema,
});

export const DEFAULT_PLAN = "plus" satisfies PlanName;

export const MODEL_ROUTING_PLANS = ModelRoutingPlansSchema.parse({
  go: {
    root: { model: "gpt-5.6-sol", reasoningEffort: "low" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "low" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "low" },
      worker: { model: "gpt-5.6-terra", reasoningEffort: "low" },
    },
    usage: { maxThreads: 1, maxDepth: 1 },
  },
  "plus-low": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "low" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
      worker: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    },
    usage: { maxThreads: 1, maxDepth: 1 },
  },
  plus: {
    root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
      librarian: { model: "gpt-5.6-terra", reasoningEffort: "low" },
      worker: { model: "gpt-5.6-terra", reasoningEffort: "high" },
    },
    usage: { maxThreads: 2, maxDepth: 1 },
  },
  "plus-high": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    agents: {
      explorer: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
      librarian: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
      worker: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    },
    usage: { maxThreads: 2, maxDepth: 1 },
  },
  "pro-5x": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
      librarian: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    },
    usage: { maxThreads: 2, maxDepth: 1 },
  },
  "pro-20x": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    },
    usage: { maxThreads: 2, maxDepth: 1 },
  },
});

export const ROOT_MODEL = MODEL_ROUTING_PLANS[DEFAULT_PLAN].root;
export const AGENT_MODELS = MODEL_ROUTING_PLANS[DEFAULT_PLAN].agents;

const LEGACY_MANAGED_AGENT_MODEL_HISTORY = {
  go: {
    explorer: [{ model: "gpt-5.6-terra", reasoningEffort: "low" }],
    librarian: [{ model: "gpt-5.6-terra", reasoningEffort: "low" }],
    worker: [{ model: "gpt-5.6-terra", reasoningEffort: "medium" }],
  },
  "plus-low": { explorer: [], librarian: [], worker: [] },
  plus: {
    explorer: [{ model: "gpt-5.6-luna", reasoningEffort: "low" }],
    librarian: [{ model: "gpt-5.6-luna", reasoningEffort: "low" }],
    worker: [{ model: "gpt-5.6-terra", reasoningEffort: "high" }],
  },
  "plus-high": { explorer: [], librarian: [], worker: [] },
  "pro-5x": {
    explorer: [{ model: "gpt-5.6-terra", reasoningEffort: "high" }],
    librarian: [{ model: "gpt-5.6-terra", reasoningEffort: "high" }],
    worker: [{ model: "gpt-5.6-sol", reasoningEffort: "medium" }],
  },
  "pro-20x": {
    explorer: [{ model: "gpt-5.6-sol", reasoningEffort: "medium" }],
    librarian: [{ model: "gpt-5.6-sol", reasoningEffort: "medium" }],
    worker: [
      { model: "gpt-5.6-sol", reasoningEffort: "high" },
      { model: "gpt-5.6-luna", reasoningEffort: "medium" },
    ],
  },
} satisfies Record<PlanName, Record<AgentName, readonly ModelRoute[]>>;

function managedPlanAgentModels(plan: PlanName): Record<AgentName, readonly ModelRoute[]> {
  return {
    explorer: [
      MODEL_ROUTING_PLANS[plan].agents.explorer,
      ...LEGACY_MANAGED_AGENT_MODEL_HISTORY[plan].explorer,
    ],
    librarian: [
      MODEL_ROUTING_PLANS[plan].agents.librarian,
      ...LEGACY_MANAGED_AGENT_MODEL_HISTORY[plan].librarian,
    ],
    worker: [
      MODEL_ROUTING_PLANS[plan].agents.worker,
      ...LEGACY_MANAGED_AGENT_MODEL_HISTORY[plan].worker,
    ],
  };
}

export const MANAGED_AGENT_MODEL_HISTORY_BY_PLAN = {
  go: managedPlanAgentModels("go"),
  "plus-low": managedPlanAgentModels("plus-low"),
  plus: managedPlanAgentModels("plus"),
  "plus-high": managedPlanAgentModels("plus-high"),
  "pro-5x": managedPlanAgentModels("pro-5x"),
  "pro-20x": managedPlanAgentModels("pro-20x"),
} satisfies Record<PlanName, Record<AgentName, readonly ModelRoute[]>>;

function managedAgentModels(agent: AgentName): readonly ModelRoute[] {
  return PLAN_NAMES.flatMap((plan) => MANAGED_AGENT_MODEL_HISTORY_BY_PLAN[plan][agent]);
}

export const MANAGED_AGENT_MODEL_HISTORY = {
  explorer: managedAgentModels("explorer"),
  librarian: managedAgentModels("librarian"),
  worker: managedAgentModels("worker"),
} satisfies Record<AgentName, readonly ModelRoute[]>;

const LEGACY_MANAGED_ROOT_MODEL_HISTORY = {
  go: [{ model: "gpt-5.6-terra", reasoningEffort: "medium" }],
  "plus-low": [],
  plus: [{ model: "gpt-5.6-sol", reasoningEffort: "medium" }],
  "plus-high": [],
  "pro-5x": [{ model: "gpt-5.6-sol", reasoningEffort: "high" }],
  "pro-20x": [{ model: "gpt-5.6-sol", reasoningEffort: "xhigh" }],
} satisfies Record<PlanName, readonly ModelRoute[]>;

function managedPlanRootModels(plan: PlanName): readonly ModelRoute[] {
  return [MODEL_ROUTING_PLANS[plan].root, ...LEGACY_MANAGED_ROOT_MODEL_HISTORY[plan]];
}

export const MANAGED_ROOT_MODEL_HISTORY_BY_PLAN = {
  go: managedPlanRootModels("go"),
  "plus-low": managedPlanRootModels("plus-low"),
  plus: managedPlanRootModels("plus"),
  "plus-high": managedPlanRootModels("plus-high"),
  "pro-5x": managedPlanRootModels("pro-5x"),
  "pro-20x": managedPlanRootModels("pro-20x"),
} satisfies Record<PlanName, readonly ModelRoute[]>;

export const GENERATED_RUNTIMES = [
  "agent-capacity.js",
  "bootstrap.js",
  "core-instructions.js",
  "detect-lsp.js",
  "git-bash.js",
  "git-bash-resolver.js",
  "LICENSE-LSP-MIT.txt",
  "LICENSE-OPENSLIMEDIT-MIT.txt",
  "lsp.js",
  "mcp-stdio-core.js",
  "rules.js",
] as const;

export const BASE_REQUIRED_RUNTIMES = ["lsp.js", "rules.js"] as const;

export const WINDOWS_REQUIRED_RUNTIMES = ["git-bash.js"] as const;

export const WINDOWS_SHELL_POLICY =
  "On native Windows, before the first shell action, inspect callable and deferred tools until `mcp__git_bash__run` is resolved. Use it for every shell command, including Git, Bash, POSIX, package, build, test, and script commands. If unavailable, stop and report the blocker. Never fall back to PowerShell or cmd.";

export type McpServerConfig = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly enabled_tools?: readonly string[];
};

/** Provides effective mcp servers. */
export function effectiveMcpServers(
  platform: NodeJS.Platform,
  packageRunner: PackageRunner = "bun",
): Record<string, McpServerConfig> {
  const codexSlimEdit = codexSlimEditInvocation({
    packageRunner,
    platform,
    packageVersion: VERSION,
  });
  return {
    ...(platform === "win32"
      ? {
          git_bash: {
            command: "node",
            args: ["runtime/git-bash.js", "mcp"],
            cwd: ".",
            enabled_tools: ["run"],
          },
        }
      : {}),
    lsp: { command: "node", args: ["runtime/lsp.js", "mcp"], cwd: "." },
    codexslimedit: { ...codexSlimEdit },
    context7: { command: "bunx", args: ["@upstash/context7-mcp"] },
  };
}

/** Returns runtime files required on a platform. */
export function requiredRuntimes(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32"
    ? [...BASE_REQUIRED_RUNTIMES, ...WINDOWS_REQUIRED_RUNTIMES]
    : BASE_REQUIRED_RUNTIMES;
}

/** Returns packaged runtime files required on a platform. */
export function requiredPackageRuntimes(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32"
    ? GENERATED_RUNTIMES
    : GENERATED_RUNTIMES.filter((file) => file !== "git-bash.js");
}
