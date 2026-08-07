import { z } from "zod";

export const VERSION = "0.12.6";

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
  targetCalls: z.number().int().positive(),
  maxCalls: z.number().int().positive(),
  workflowDepth: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
  loopIterations: z.number().int().positive(),
  fanOut: z.number().int().positive(),
});
export type WorkflowLimits = z.infer<typeof WorkflowLimitsSchema>;

const ProjectedUsageRangeSchema = z.strictObject({
  minimum: z.number().positive(),
  maximum: z.number().positive(),
});
export type ProjectedUsageRange = z.infer<typeof ProjectedUsageRangeSchema>;

const WorkflowPolicySchema = z.strictObject({
  permittedRoutes: z.strictObject({
    explorer: z.record(WorkflowStageSchema, z.array(ModelRouteSchema).min(1)),
    librarian: z.record(WorkflowStageSchema, z.array(ModelRouteSchema).min(1)),
    worker: z.record(WorkflowStageSchema, z.array(ModelRouteSchema).min(1)),
  }),
  verbosity: z.literal("low"),
  serviceTiers: z.tuple([z.literal("default"), z.literal("fast")]),
  limits: WorkflowLimitsSchema,
  projectedUsage: z.strictObject({
    standard: ProjectedUsageRangeSchema,
    fast: ProjectedUsageRangeSchema,
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
  permittedRoutes: WorkflowPolicy["permittedRoutes"],
  limits: Pick<
    WorkflowLimits,
    | "concurrency"
    | "targetCalls"
    | "maxCalls"
    | "workflowDepth"
    | "retries"
    | "loopIterations"
    | "fanOut"
  >,
  projectedUsage: ProjectedUsageRange,
  maxInputTokens: number,
): WorkflowPolicy {
  return {
    permittedRoutes,
    verbosity: "low",
    serviceTiers: ["default", "fast"],
    limits,
    projectedUsage: {
      standard: projectedUsage,
      fast: {
        minimum: projectedUsage.minimum * 2,
        maximum: projectedUsage.maximum * 2,
      },
    },
    softSizeGuidance: { maxInputTokens, maxScriptBytes: Math.min(maxInputTokens, 4 * 1024 * 1024) },
  };
}

export const DEFAULT_PLAN = "plus-low" satisfies PlanName;

const LUNA_HIGH = { model: "gpt-5.6-luna", reasoningEffort: "high" } as const;
const LUNA_XHIGH = { model: "gpt-5.6-luna", reasoningEffort: "xhigh" } as const;
const LUNA_MAX = { model: "gpt-5.6-luna", reasoningEffort: "max" } as const;

function uniformStageRoutes(...routes: readonly ModelRoute[]): Record<WorkflowStage, ModelRoute[]> {
  return Object.fromEntries(WORKFLOW_STAGES.map((stage) => [stage, [...routes]])) as Record<
    WorkflowStage,
    ModelRoute[]
  >;
}

export const MODEL_ROUTING_PLANS = ModelRoutingPlansSchema.parse({
  go: {
    root: LUNA_HIGH,
    agents: { explorer: LUNA_HIGH, librarian: LUNA_HIGH, worker: LUNA_HIGH },
    workflow: workflowFor(
      {
        explorer: uniformStageRoutes(LUNA_HIGH),
        librarian: uniformStageRoutes(LUNA_HIGH),
        worker: uniformStageRoutes(LUNA_HIGH),
      },
      {
        concurrency: 1,
        targetCalls: 2,
        maxCalls: 4,
        workflowDepth: 2,
        retries: 0,
        loopIterations: 1,
        fanOut: 1,
      },
      { minimum: 0.2, maximum: 0.35 },
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
        explorer: uniformStageRoutes(LUNA_HIGH),
        librarian: uniformStageRoutes(LUNA_HIGH),
        worker: uniformStageRoutes(LUNA_HIGH),
      },
      {
        concurrency: 3,
        targetCalls: 4,
        maxCalls: 12,
        workflowDepth: 3,
        retries: 1,
        loopIterations: 2,
        fanOut: 3,
      },
      { minimum: 1, maximum: 1 },
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
        explorer: uniformStageRoutes(LUNA_HIGH),
        librarian: uniformStageRoutes(LUNA_HIGH),
        worker: {
          analysis: [LUNA_HIGH, LUNA_XHIGH],
          research: [LUNA_HIGH],
          implementation: [LUNA_HIGH, LUNA_XHIGH],
          verification: [LUNA_XHIGH],
        },
      },
      {
        concurrency: 3,
        targetCalls: 6,
        maxCalls: 16,
        workflowDepth: 4,
        retries: 2,
        loopIterations: 3,
        fanOut: 3,
      },
      { minimum: 1.4, maximum: 1.7 },
      50_000,
    ),
  },
  "plus-high": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
    },
    workflow: workflowFor(
      {
        explorer: uniformStageRoutes(LUNA_HIGH, LUNA_XHIGH),
        librarian: uniformStageRoutes(LUNA_HIGH, LUNA_XHIGH),
        worker: {
          analysis: [LUNA_XHIGH],
          research: [LUNA_XHIGH],
          implementation: [LUNA_XHIGH, LUNA_MAX],
          verification: [LUNA_MAX],
        },
      },
      {
        concurrency: 4,
        targetCalls: 8,
        maxCalls: 24,
        workflowDepth: 5,
        retries: 3,
        loopIterations: 4,
        fanOut: 4,
      },
      { minimum: 2.4, maximum: 3.1 },
      70_000,
    ),
  },
  "pro-5x": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
    },
    workflow: workflowFor(
      {
        explorer: uniformStageRoutes(LUNA_XHIGH),
        librarian: uniformStageRoutes(LUNA_XHIGH),
        worker: {
          analysis: [LUNA_XHIGH, LUNA_MAX],
          research: [LUNA_XHIGH],
          implementation: [LUNA_MAX],
          verification: [LUNA_MAX],
        },
      },
      {
        concurrency: 6,
        targetCalls: 12,
        maxCalls: 40,
        workflowDepth: 6,
        retries: 3,
        loopIterations: 5,
        fanOut: 5,
      },
      { minimum: 4, maximum: 5 },
      100_000,
    ),
  },
  "pro-20x": {
    root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    agents: {
      explorer: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      librarian: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      worker: { model: "gpt-5.6-luna", reasoningEffort: "max" },
    },
    workflow: workflowFor(
      {
        explorer: uniformStageRoutes(LUNA_XHIGH, LUNA_MAX),
        librarian: uniformStageRoutes(LUNA_XHIGH, LUNA_MAX),
        worker: uniformStageRoutes(LUNA_MAX),
      },
      {
        concurrency: 8,
        targetCalls: 20,
        maxCalls: 80,
        workflowDepth: 8,
        retries: 4,
        loopIterations: 8,
        fanOut: 8,
      },
      { minimum: 8, maximum: 12 },
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
      { model: "gpt-5.6-luna", reasoningEffort: "high" },
      { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { model: "gpt-5.6-terra", reasoningEffort: "medium" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
    librarian: [
      { model: "gpt-5.6-luna", reasoningEffort: "high" },
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
      { model: "gpt-5.6-luna", reasoningEffort: "high" },
      { model: "gpt-5.6-luna", reasoningEffort: "max" },
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ],
    librarian: [
      { model: "gpt-5.6-luna", reasoningEffort: "high" },
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
  "plus-high": [{ model: "gpt-5.6-sol", reasoningEffort: "medium" }],
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
