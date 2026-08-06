import { z } from "zod";

export const VERSION = "0.12.1";

export const SKILLS = [
  "ast-grep",
  "babysit-ci",
  "code-review",
  "compress",
  "context7-cli",
  "debugging",
  "handoff",
  "lsp",
  "lsp-setup",
  "plan",
  "plan-review",
  "programming",
  "refactor",
  "remove-slop",
  "rules",
  "workflows",
] as const;

export const AgentNameSchema = z.enum(["explorer", "librarian", "worker"]);
export const AGENTS = AgentNameSchema.options;
export type AgentName = z.infer<typeof AgentNameSchema>;

export const PlanNameSchema = z.enum(["go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"]);
export const PLAN_NAMES = PlanNameSchema.options;
export type PlanName = z.infer<typeof PlanNameSchema>;

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const FastModeSchema = z.enum(["standard", "fast", "fast-all"]);
export type FastMode = z.infer<typeof FastModeSchema>;

const ModelRouteSchema = z.discriminatedUnion("model", [
  z.strictObject({
    model: z.literal("gpt-5.6-luna"),
    reasoningEffort: ReasoningEffortSchema,
  }),
  z.strictObject({
    model: z.literal("gpt-5.6-terra"),
    reasoningEffort: ReasoningEffortSchema,
  }),
  z.strictObject({
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: ReasoningEffortSchema,
  }),
]);
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const WORKFLOW_STAGES = ["analysis", "research", "implementation", "verification"] as const;
export const WorkflowStageSchema = z.enum(WORKFLOW_STAGES);
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

const WorkflowLimitsSchema = z.strictObject({
  concurrency: z.number().int().positive(),
  totalCalls: z.number().int().positive(),
  workflowDepth: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
  loopIterations: z.number().int().positive(),
  fanOut: z.number().int().positive(),
  maxConcurrency: z.number().int().positive(),
  maxCalls: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
});
export type WorkflowLimits = z.infer<typeof WorkflowLimitsSchema>;

const WorkflowPolicySchema = z.strictObject({
  permittedRoutes: z.strictObject({
    explorer: z.record(WorkflowStageSchema, z.array(ModelRouteSchema).min(1)),
    librarian: z.record(WorkflowStageSchema, z.array(ModelRouteSchema).min(1)),
    worker: z.record(WorkflowStageSchema, z.array(ModelRouteSchema).min(1)),
  }),
  verbosity: z.literal("low"),
  serviceTiers: z.tuple([z.literal("default"), z.literal("fast")]),
  limits: WorkflowLimitsSchema,
  projectedUsage: z.strictObject({ standard: z.number().positive(), fast: z.number().positive() }),
  runtime: z.strictObject({
    maxSeconds: z.number().int().positive(),
    maxRuntimeMs: z.number().int().positive(),
  }),
  softSizeGuidance: z.strictObject({
    maxInputTokens: z.number().int().positive(),
    maxScriptBytes: z.number().int().positive(),
  }),
});
export type WorkflowPolicy = z.infer<typeof WorkflowPolicySchema>;

const RoutingPresetSchema = z.strictObject({
  root: ModelRouteSchema,
  agents: z.strictObject({
    explorer: ModelRouteSchema,
    librarian: ModelRouteSchema,
    worker: ModelRouteSchema,
  }),
  workflow: WorkflowPolicySchema,
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

function workflowFor(
  agents: Record<AgentName, ModelRoute>,
  limits: Pick<
    WorkflowLimits,
    "concurrency" | "totalCalls" | "workflowDepth" | "retries" | "loopIterations" | "fanOut"
  >,
  projectedUsage: number,
  maxSeconds: number,
  maxInputTokens: number,
): WorkflowPolicy {
  const permittedRoutes = Object.fromEntries(
    AGENTS.map((agent) => [
      agent,
      Object.fromEntries(WORKFLOW_STAGES.map((stage) => [stage, [agents[agent]]])),
    ]),
  ) as WorkflowPolicy["permittedRoutes"];
  return {
    permittedRoutes,
    verbosity: "low",
    serviceTiers: ["default", "fast"],
    limits: {
      ...limits,
      maxConcurrency: limits.concurrency,
      maxCalls: limits.totalCalls,
      maxRetries: limits.retries,
    },
    projectedUsage: { standard: projectedUsage, fast: projectedUsage * 2 },
    runtime: { maxSeconds, maxRuntimeMs: maxSeconds * 1_000 },
    softSizeGuidance: { maxInputTokens, maxScriptBytes: Math.min(maxInputTokens, 4 * 1024 * 1024) },
  };
}

export const DEFAULT_PLAN = "plus" satisfies PlanName;

export const MODEL_ROUTING_PLANS = ModelRoutingPlansSchema.parse({
  go: {
    root: { model: "gpt-5.6-luna", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
    },
    workflow: workflowFor(
      {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      },
      { concurrency: 1, totalCalls: 4, workflowDepth: 2, retries: 0, loopIterations: 1, fanOut: 1 },
      4,
      120,
      20_000,
    ),
  },
  "plus-low": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "low" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
    },
    workflow: workflowFor(
      {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      },
      {
        concurrency: 3,
        totalCalls: 12,
        workflowDepth: 3,
        retries: 1,
        loopIterations: 2,
        fanOut: 3,
      },
      12,
      300,
      30_000,
    ),
  },
  plus: {
    root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
    },
    workflow: workflowFor(
      {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      },
      {
        concurrency: 3,
        totalCalls: 16,
        workflowDepth: 4,
        retries: 2,
        loopIterations: 3,
        fanOut: 3,
      },
      16,
      600,
      50_000,
    ),
  },
  "plus-high": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
    },
    workflow: workflowFor(
      {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      },
      {
        concurrency: 4,
        totalCalls: 24,
        workflowDepth: 5,
        retries: 3,
        loopIterations: 4,
        fanOut: 4,
      },
      24,
      900,
      70_000,
    ),
  },
  "pro-5x": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
    },
    workflow: workflowFor(
      {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      },
      {
        concurrency: 6,
        totalCalls: 40,
        workflowDepth: 6,
        retries: 3,
        loopIterations: 5,
        fanOut: 5,
      },
      40,
      1_200,
      100_000,
    ),
  },
  "pro-20x": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "max" },
    },
    workflow: workflowFor(
      {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        worker: { model: "gpt-5.6-luna", reasoningEffort: "max" },
      },
      {
        concurrency: 8,
        totalCalls: 80,
        workflowDepth: 8,
        retries: 4,
        loopIterations: 8,
        fanOut: 8,
      },
      80,
      2_400,
      150_000,
    ),
  },
});

/** Plan-authoritative workflow policies. */
export const WORKFLOW_POLICIES = Object.fromEntries(
  PLAN_NAMES.map((plan) => [plan, MODEL_ROUTING_PLANS[plan].workflow]),
) as Record<PlanName, WorkflowPolicy>;

/** Per-plan workflow quotas used by configuration and doctor. */
export const WORKFLOW_LIMITS_BY_PLAN = Object.fromEntries(
  PLAN_NAMES.map((plan) => [plan, MODEL_ROUTING_PLANS[plan].workflow.limits]),
) as Record<PlanName, WorkflowLimits>;

export const ROOT_MODEL = MODEL_ROUTING_PLANS[DEFAULT_PLAN].root;
export const AGENT_MODELS = MODEL_ROUTING_PLANS[DEFAULT_PLAN].agents;

const LEGACY_MANAGED_AGENT_MODEL_HISTORY = {
  go: {
    explorer: [
      { model: "gpt-5.6-luna", reasoningEffort: "low" },
      { model: "gpt-5.6-terra", reasoningEffort: "low" },
    ],
    librarian: [
      { model: "gpt-5.6-luna", reasoningEffort: "low" },
      { model: "gpt-5.6-terra", reasoningEffort: "low" },
    ],
    worker: [
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "low" },
      { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    ],
  },
  "plus-low": {
    explorer: [{ model: "gpt-5.6-luna", reasoningEffort: "low" }],
    librarian: [{ model: "gpt-5.6-luna", reasoningEffort: "medium" }],
    worker: [
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    ],
  },
  plus: {
    explorer: [
      { model: "gpt-5.6-luna", reasoningEffort: "low" },
      { model: "gpt-5.6-luna", reasoningEffort: "medium" },
    ],
    librarian: [
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-luna", reasoningEffort: "low" },
      { model: "gpt-5.6-terra", reasoningEffort: "low" },
      { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    ],
    worker: [
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
  },
  "plus-high": {
    explorer: [
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    ],
    librarian: [
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    ],
    worker: [
      { model: "gpt-5.6-luna", reasoningEffort: "max" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
      { model: "gpt-5.6-sol", reasoningEffort: "low" },
    ],
  },
  "pro-5x": {
    explorer: [
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "medium" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
    librarian: [
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
    worker: [
      { model: "gpt-5.6-luna", reasoningEffort: "max" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ],
  },
  "pro-20x": {
    explorer: [
      { model: "gpt-5.6-luna", reasoningEffort: "max" },
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ],
    librarian: [
      { model: "gpt-5.6-luna", reasoningEffort: "max" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ],
    worker: [
      { model: "gpt-5.6-terra", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
      { model: "gpt-5.6-luna", reasoningEffort: "medium" },
      { model: "gpt-5.6-sol", reasoningEffort: "high" },
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
  go: [
    { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
    { model: "gpt-5.6-sol", reasoningEffort: "low" },
    { model: "gpt-5.6-terra", reasoningEffort: "medium" },
  ],
  "plus-low": [],
  plus: [],
  "plus-high": [],
  "pro-5x": [{ model: "gpt-5.6-sol", reasoningEffort: "medium" }],
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
  "LICENSE-QUICKJS-EMSCRIPTEN-MIT.txt",
  "lsp.js",
  "rules.js",
  "workflow.js",
  "workflow-evaluator.js",
] as const;

export const BASE_REQUIRED_RUNTIMES = [
  "lsp.js",
  "rules.js",
  "workflow.js",
  "workflow-evaluator.js",
] as const;

export const WINDOWS_REQUIRED_RUNTIMES = ["git-bash.js"] as const;

export const WINDOWS_SHELL_POLICY =
  "On native Windows, run every shell command through the bundled Git Bash launcher, including Git, package, build, test, script and POSIX commands. Never execute task commands through PowerShell or cmd. If Git Bash cannot be resolved, stop and report the blocker. On non-Windows, use the native shell normally.";

export const LITE_WRITING_POLICY =
  "Communicate grammatically and concisely. Omit filler, hedging, repetition, decoration, self-reference, style announcements and tool narration. Preserve exact technical terms, APIs, commands, paths, errors and commit keywords. Use fuller grammar for safety, ambiguity, clarification and ordered instructions. Apply this policy only to agent communication, never to literal authored or transformed content, UI or accessibility labels, help text, errors, logs, tests, fixtures, documentation, comments, commit or PR text, authored prompts, translations, quotations, generated content, public APIs, or existing repository and product voice.";

export const CONTEXT7_POLICY =
  "Within assigned scope, use the Context7 CLI skill first for current library, framework, SDK and API documentation. Use live web search for releases, dates, broader research, missing Context7 coverage and corroboration. Context7 does not authorize scope expansion.";

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
