import { z } from "zod";

export const VERSION = "0.7.1";

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

export const PlanNameSchema = z.enum(["go", "plus", "pro-5x", "pro-20x"]);
export const PLAN_NAMES = PlanNameSchema.options;
export type PlanName = z.infer<typeof PlanNameSchema>;

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

const ModelRouteSchema = z.discriminatedUnion("model", [
  z.strictObject({
    model: z.literal("gpt-5.6-luna"),
    reasoningEffort: z.enum(["low", "medium"]),
  }),
  z.strictObject({
    model: z.literal("gpt-5.6-terra"),
    reasoningEffort: z.enum(["low", "medium", "high"]),
  }),
  z.strictObject({
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.enum(["medium", "high", "xhigh"]),
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
});
export type RoutingPreset = z.infer<typeof RoutingPresetSchema>;

export const ModelRoutingPlansSchema = z.strictObject({
  go: RoutingPresetSchema,
  plus: RoutingPresetSchema,
  "pro-5x": RoutingPresetSchema,
  "pro-20x": RoutingPresetSchema,
});

export const DEFAULT_PLAN = "plus" satisfies PlanName;

export const MODEL_ROUTING_PLANS = ModelRoutingPlansSchema.parse({
  go: {
    root: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    agents: {
      explorer: { model: "gpt-5.6-terra", reasoningEffort: "low" },
      librarian: { model: "gpt-5.6-terra", reasoningEffort: "low" },
      worker: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    },
  },
  plus: {
    root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "low" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "low" },
      worker: { model: "gpt-5.6-terra", reasoningEffort: "high" },
    },
  },
  "pro-5x": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    },
  },
  "pro-20x": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    agents: {
      explorer: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      librarian: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      worker: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    },
  },
});

export const ROOT_MODEL = MODEL_ROUTING_PLANS[DEFAULT_PLAN].root;
export const AGENT_MODELS = MODEL_ROUTING_PLANS[DEFAULT_PLAN].agents;

function managedAgentModels(agent: AgentName): readonly ModelRoute[] {
  const routes = PLAN_NAMES.map((plan) => MODEL_ROUTING_PLANS[plan].agents[agent]);
  return agent === "worker"
    ? [...routes, { model: "gpt-5.6-luna", reasoningEffort: "medium" }]
    : routes;
}

export const MANAGED_AGENT_MODEL_HISTORY = {
  explorer: managedAgentModels("explorer"),
  librarian: managedAgentModels("librarian"),
  worker: managedAgentModels("worker"),
} satisfies Record<AgentName, readonly ModelRoute[]>;

export const GENERATED_RUNTIMES = [
  "bootstrap.js",
  "core-instructions.js",
  "git-bash.js",
  "git-bash-resolver.js",
  "LICENSE-LSP-MIT.txt",
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
export function effectiveMcpServers(platform: NodeJS.Platform): Record<string, McpServerConfig> {
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
