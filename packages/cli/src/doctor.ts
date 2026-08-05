import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../../git-bash/src/git-bash-resolver.ts";
import { runManagedProcess } from "../../runtime-core/src/process.ts";
import {
  AGENTS,
  MODEL_ROUTING_PLANS,
  requiredPackageRuntimes,
  SKILLS,
  VERSION,
} from "./catalog.ts";
import {
  readManagedFastMode,
  readManagedPlan,
  readManagedWorkflowPolicy,
  readPreservedRootOverrides,
} from "./config.ts";
import { context7Command, executableOnPath } from "./context7.ts";
import { rootTomlString, rootTomlStringArray } from "./toml.ts";

export type CheckStatus = "ok" | "warning" | "error";
export type DoctorCheck = {
  readonly id: string;
  readonly status: CheckStatus;
  readonly code: string;
  readonly detail: string;
  readonly fix?: string;
};
export type DoctorResult = {
  readonly healthy: boolean;
  readonly autonomy: "safe-workspace" | "autonomous-workspace" | "dangerous" | "unknown";
  readonly checks: readonly DoctorCheck[];
};
type CommandResult = { readonly ok: boolean; readonly output: string };
export type DoctorRuntime = {
  readonly platform: NodeJS.Platform;
  readonly command: (
    name: string,
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
  ) => Promise<CommandResult>;
  readonly executable: (name: string) => boolean;
  readonly gitBash: () => GitBashResolution;
};

const COMPATIBILITY_KEYS = ["desktop.show-context-window-usage"] as const;

async function runCommand(
  name: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runManagedProcess({
    command: name,
    args,
    platform: process.platform,
    timeoutMs: 15_000,
    maxOutputChars: 64 * 1024,
    ...(env === undefined ? {} : { env }),
  });
  return {
    ok: result.exitCode === 0 && !result.timedOut && result.error === undefined,
    output: `${result.stdout}\n${result.stderr}`.trim() || result.error || "",
  };
}

const defaultRuntime: DoctorRuntime = {
  platform: process.platform,
  command: runCommand,
  executable: executableOnPath,
  gitBash: resolveGitBashForCurrentProcess,
};

function check(
  id: string,
  status: CheckStatus,
  code: string,
  detail: string,
  fix?: string,
): DoctorCheck {
  return { id, status, code, detail, ...(fix === undefined ? {} : { fix }) };
}

async function missingFiles(root: string, paths: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    try {
      await access(join(root, path));
    } catch {
      missing.push(path);
    }
  }
  return missing;
}

function tableBody(config: string, table: string): string | undefined {
  return new RegExp(
    `^\\s*\\[${table.replaceAll(".", "\\.")}]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`,
    "m",
  ).exec(config)?.[1];
}

function tableValue(config: string, table: string, key: string): string | undefined {
  const body = tableBody(config, table);
  return body === undefined
    ? undefined
    : new RegExp(`^\\s*${key.replaceAll("-", "\\-")}\\s*=\\s*(.+?)\\s*$`, "m").exec(body)?.[1];
}

function autonomy(config: string): DoctorResult["autonomy"] {
  const approval = rootTomlString(config, "approval_policy");
  const reviewer = rootTomlString(config, "approvals_reviewer");
  const sandbox = rootTomlString(config, "sandbox_mode");
  const network = tableValue(config, "sandbox_workspace_write", "network_access");
  if (
    approval === "on-request" &&
    reviewer === "auto_review" &&
    sandbox === "workspace-write" &&
    network === "true"
  )
    return "safe-workspace";
  if (
    approval === "never" &&
    reviewer === undefined &&
    sandbox === "workspace-write" &&
    network === "true"
  )
    return "autonomous-workspace";
  if (approval === "never" && reviewer === undefined && sandbox === "danger-full-access")
    return "dangerous";
  return "unknown";
}

/** Runs installation, configuration, runtime, and override health checks. */
export async function doctor(
  home = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  runtime: DoctorRuntime = defaultRuntime,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const pluginRoot = join(home, "plugins", "cache", "holycodex", "holycodex", VERSION);
  const agentRoot = join(home, "holycodex", "agents");
  const configPath = join(home, "config.toml");
  let config = "";
  try {
    config = await readFile(configPath, "utf8");
  } catch {
    checks.push(
      check(
        "config",
        "error",
        "config-missing",
        `Missing ${configPath}.`,
        "Run holycodex install.",
      ),
    );
  }

  const required = [
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    ...requiredPackageRuntimes(runtime.platform).map((file) => `runtime/${file}`),
    ...AGENTS.map((name) => `agents/${name}.toml`),
    ...SKILLS.map((name) => `skills/${name}/SKILL.md`),
  ];
  const missing = await missingFiles(pluginRoot, required);
  checks.push(
    missing.length === 0
      ? check(
          "package",
          "ok",
          "package-ready",
          `Plugin ${VERSION}, runtimes, agents, and ${SKILLS.length} skills are present.`,
        )
      : check(
          "package",
          "error",
          "package-incomplete",
          `Missing ${missing.join(", ")}.`,
          "Reinstall HolyCodex.",
        ),
  );
  const webSearchOverride = readPreservedRootOverrides(config).webSearch;
  checks.push(
    rootTomlString(config, "web_search") === "live"
      ? check("web-search", "ok", "live-web-search", "Managed web search defaults to live.")
      : webSearchOverride
        ? check(
            "web-search",
            "ok",
            "web-search-override",
            "An intentional user web-search override is preserved.",
          )
        : check(
            "web-search",
            "error",
            "web-search-not-live",
            "Managed web search is not live.",
            "Reinstall HolyCodex.",
          ),
  );
  const status =
    rootTomlStringArray(config, "status_line") ??
    rootTomlStringArray(tableBody(config, "tui") ?? "", "status_line");
  checks.push(
    status?.includes("context-remaining")
      ? check(
          "context-visibility",
          "ok",
          "context-visible",
          "Context-window usage remains visible.",
        )
      : check(
          "context-visibility",
          "error",
          "context-hidden",
          "The status line does not show context remaining.",
          "Reinstall HolyCodex.",
        ),
  );
  checks.push(
    check(
      "screenshot",
      "ok",
      "screenshot-default-preserved",
      "HolyCodex does not override the enabled Codex screenshot default.",
    ),
  );

  const context7 = context7Command(["--version"], runtime.executable);
  if (context7 === undefined)
    checks.push(
      check(
        "context7",
        "error",
        "context7-runner-missing",
        "No supported direct Context7 runner is available.",
        "Install nub, Bun, pnpm, npm, or Yarn.",
      ),
    );
  else {
    checks.push(
      check(
        "context7",
        "ok",
        "context7-cli-ready",
        `${context7.command} constructs a valid direct ctx7@latest command.`,
      ),
    );
  }

  const lsp = await runtime.command(
    process.execPath,
    [join(pluginRoot, "runtime", "lsp.js"), "status", "--json"],
    {
      ...process.env,
      HOLYCODEX_LSP_IDLE_SHUTDOWN_MS: "0",
      HOLYCODEX_LSP_IDLE_CHECK_INTERVAL_MS: "50",
    },
  );
  checks.push(
    lsp.ok
      ? check("lsp", "ok", "lsp-cli-ready", "The LSP CLI and daemon are reachable.")
      : check(
          "lsp",
          "error",
          "lsp-cli-failed",
          lsp.output || "LSP CLI failed.",
          "Reinstall HolyCodex and inspect the reported daemon log.",
        ),
  );
  if (runtime.platform === "win32") {
    const resolution = runtime.gitBash();
    checks.push(
      resolution.found
        ? check(
            "git-bash",
            "ok",
            "git-bash-launcher-ready",
            `Git Bash resolves at ${resolution.path}; the bundled launcher is present.`,
          )
        : check(
            "git-bash",
            "error",
            "git-bash-unavailable",
            resolution.installHint,
            resolution.installHint,
          ),
    );
  }

  const plan = readManagedPlan(config);
  const overrides = readPreservedRootOverrides(config);
  const fast = readManagedFastMode(config);
  const workflow = readManagedWorkflowPolicy(config);
  checks.push(
    plan === undefined
      ? check(
          "routes",
          "error",
          "route-plan-missing",
          "Managed route plan metadata is missing.",
          "Reinstall HolyCodex.",
        )
      : check(
          "routes",
          "ok",
          "routes-ready",
          `${plan} workflow policy is active with permitted stage routes.`,
        ),
  );
  checks.push(
    plan === undefined || workflow === undefined
      ? check(
          "workflow",
          "error",
          "workflow-settings-missing",
          "Managed workflow settings are missing or invalid.",
          "Reinstall HolyCodex.",
        )
      : JSON.stringify(workflow) ===
          JSON.stringify({
            plan,
            limits: MODEL_ROUTING_PLANS[plan].workflow.limits,
            projectedUsage: MODEL_ROUTING_PLANS[plan].workflow.projectedUsage,
            runtime: MODEL_ROUTING_PLANS[plan].workflow.runtime,
            softSizeGuidance: MODEL_ROUTING_PLANS[plan].workflow.softSizeGuidance,
          })
        ? check(
            "workflow",
            "ok",
            "workflow-settings-ready",
            `${plan} workflow limits, projected usage, runtime, and size guidance match the catalog.`,
          )
        : check(
            "workflow",
            "error",
            "workflow-settings-drift",
            `${plan} workflow settings do not match the authoritative catalog.`,
            "Reinstall HolyCodex.",
          ),
  );
  checks.push(
    missing.includes("runtime/workflow.js")
      ? check(
          "workflow-runtime",
          "error",
          "workflow-runtime-missing",
          "The isolated workflow runtime is missing.",
          "Reinstall HolyCodex.",
        )
      : check(
          "workflow-runtime",
          "ok",
          "workflow-runtime-ready",
          "The isolated workflow runtime is present.",
        ),
  );
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = await readFile(manifestPath, "utf8").catch(() => "");
  const mcpManifest = await access(join(pluginRoot, ".mcp.json"))
    .then(() => true)
    .catch(() => false);
  checks.push(
    !mcpManifest && !manifest.includes("mcpServers") && !manifest.includes("MCP Tools")
      ? check("mcp", "ok", "mcp-free", "The installation does not declare MCP servers or tools.")
      : check(
          "mcp",
          "error",
          "mcp-declared",
          "The installation declares MCP servers or tools.",
          "Reinstall HolyCodex from a MCP-free package.",
        ),
  );
  checks.push(
    overrides.model || overrides.reasoningEffort
      ? check(
          "root-overrides",
          "ok",
          "root-overrides-preserved",
          "Intentional Root model or reasoning overrides are preserved and healthy.",
        )
      : check("root-overrides", "ok", "root-managed-defaults", "Root uses managed route defaults."),
  );
  if (plan !== undefined && fast === undefined)
    checks.push(
      check(
        "fast",
        "warning",
        "fast-metadata-missing",
        "Fast metadata is missing; doctor will not guess a service tier.",
        "Reinstall with an explicit Fast mode.",
      ),
    );
  if (plan !== undefined) {
    for (const agent of AGENTS) {
      const source = await readFile(join(agentRoot, `${agent}.toml`), "utf8").catch(() => "");
      const expected = MODEL_ROUTING_PLANS[plan].agents[agent];
      const overridden =
        rootTomlString(source, "model") !== expected.model ||
        rootTomlString(source, "model_reasoning_effort") !== expected.reasoningEffort;
      checks.push(
        check(
          `agent-${agent}`,
          "ok",
          overridden ? "agent-override-preserved" : "agent-managed-default",
          overridden
            ? `${agent} has an intentional healthy route override.`
            : `${agent} uses managed route defaults.`,
        ),
      );
    }
  }
  for (const key of COMPATIBILITY_KEYS)
    if (config.includes(key.split(".")[1] ?? key))
      checks.push(
        check(
          `compat-${key}`,
          "warning",
          "compatibility-sensitive-key",
          `${key} is compatibility-sensitive and isolated from supported managed Codex keys.`,
        ),
      );
  return {
    healthy: checks.every((item) => item.status !== "error"),
    autonomy: autonomy(config),
    checks,
  };
}
