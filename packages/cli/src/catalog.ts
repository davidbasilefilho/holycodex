export const VERSION = "0.6.1";

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

export const AGENTS = ["explorer", "librarian", "worker"] as const;

export type AgentName = (typeof AGENTS)[number];

export const ROOT_MODEL = {
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
} as const;

export const AGENT_MODELS = {
  explorer: { model: "gpt-5.6-luna", reasoningEffort: "low" },
  librarian: { model: "gpt-5.6-luna", reasoningEffort: "low" },
  worker: { model: "gpt-5.6-terra", reasoningEffort: "high" },
} as const satisfies Record<
  AgentName,
  { readonly model: string; readonly reasoningEffort: string }
>;

export const MANAGED_AGENT_MODEL_HISTORY = {
  explorer: [{ model: "gpt-5.6-luna", reasoningEffort: "low" }],
  librarian: [{ model: "gpt-5.6-luna", reasoningEffort: "low" }],
  worker: [
    { model: "gpt-5.6-luna", reasoningEffort: "medium" },
    { model: "gpt-5.6-terra", reasoningEffort: "high" },
  ],
} as const satisfies Record<
  AgentName,
  readonly { readonly model: string; readonly reasoningEffort: string }[]
>;

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

export function requiredRuntimes(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32"
    ? [...BASE_REQUIRED_RUNTIMES, ...WINDOWS_REQUIRED_RUNTIMES]
    : BASE_REQUIRED_RUNTIMES;
}

export function requiredPackageRuntimes(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32"
    ? GENERATED_RUNTIMES
    : GENERATED_RUNTIMES.filter(
        (file) => file !== "git-bash.js" && file !== "git-bash-resolver.js",
      );
}
