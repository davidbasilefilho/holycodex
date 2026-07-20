import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../../git-bash-mcp/src/git-bash-resolver.ts";
import { runManagedProcess } from "../../mcp-stdio-core/src/process.ts";
import {
  AGENTS,
  MODEL_ROUTING_PLANS,
  effectiveMcpServers,
  type McpServerConfig,
  requiredPackageRuntimes,
  SKILLS,
  VERSION,
} from "./catalog.ts";
import { readManagedMaxSubagents, readManagedPlan, readPreservedRootOverrides } from "./config.ts";
import { rootTomlString, rootTomlStringArray } from "./toml.ts";

const McpManifestSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())),
});

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
type Context7Result = {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly packageFailure: boolean;
  readonly detail: string;
};
export type DoctorRuntime = {
  readonly platform: NodeJS.Platform;
  readonly command: (name: string, args: readonly string[]) => Promise<CommandResult>;
  readonly context7: () => Promise<Context7Result>;
  readonly gitBash: () => GitBashResolution;
};

async function runCommand(
  name: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): Promise<CommandResult> {
  const result = await runManagedProcess({
    command: name,
    args,
    platform,
    timeoutMs: 10_000,
    maxOutputChars: 64 * 1024,
  });
  return {
    ok: result.exitCode === 0 && !result.timedOut && result.error === undefined,
    output: `${result.stdout}\n${result.stderr}`.trim() || result.error || "",
  };
}

async function startContext7(platform: NodeJS.Platform): Promise<Context7Result> {
  const result = await runManagedProcess({
    command: "bunx",
    args: ["@upstash/context7-mcp"],
    platform,
    timeoutMs: 15_000,
    maxOutputChars: 128 * 1024,
    stdin: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "holycodex-doctor", version: VERSION } } })}\n`,
    matchOutput: (output) => output.includes('"serverInfo"') || output.includes('"capabilities"'),
  });
  const diagnostic = `${result.stdout}\n${result.stderr}`.trim() || result.error || "";
  return {
    ok: result.matched && !result.timedOut,
    timedOut: result.timedOut,
    packageFailure: /(?:404|failed to resolve|package.*not found|error: GET)/i.test(diagnostic),
    detail: diagnostic,
  };
}

const defaultRuntime: DoctorRuntime = {
  platform: process.platform,
  command: (name, args) =>
    process.env.NODE_ENV === "test" &&
    process.env.HOLYCODEX_TEST_SKIP_PACKAGE_RESOLUTION === "1" &&
    args.some((argument) => argument.startsWith("codexslimedit@"))
      ? Promise.resolve({ ok: true, output: "package resolution skipped in tests" })
      : runCommand(name, args, process.platform),
  context7: () => startContext7(process.platform),
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

function mcpConfigMatches(actual: Record<string, unknown>, expected: McpServerConfig): boolean {
  const expectedEntries = Object.entries(expected);
  if (Object.keys(actual).length !== expectedEntries.length) return false;
  return expectedEntries.every(([key, expectedValue]) => {
    const actualValue = actual[key];
    return Array.isArray(expectedValue)
      ? Array.isArray(actualValue) &&
          actualValue.length === expectedValue.length &&
          actualValue.every((value, index) => value === expectedValue[index])
      : actualValue === expectedValue;
  });
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

function tableBoolean(config: string, table: string, key: string): boolean | undefined {
  const body = new RegExp(
    `^\\s*\\[${table.replaceAll(".", "\\.")}]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`,
    "m",
  ).exec(config)?.[1];
  const value =
    body === undefined
      ? undefined
      : new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, "m").exec(body)?.[1];
  return value === undefined ? undefined : value === "true";
}

function tableInteger(config: string, table: string, key: string): number | undefined {
  const body = new RegExp(
    `^\\s*\\[${table.replaceAll(".", "\\.")}]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`,
    "m",
  ).exec(config)?.[1];
  const value =
    body === undefined ? undefined : new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, "m").exec(body)?.[1];
  return value === undefined ? undefined : Number(value);
}

function autonomy(config: string): DoctorResult["autonomy"] {
  const approval = rootTomlString(config, "approval_policy");
  const sandbox = rootTomlString(config, "sandbox_mode");
  const network = tableBoolean(config, "sandbox_workspace_write", "network_access");
  if (approval === "on-request" && sandbox === "workspace-write" && network === true)
    return "safe-workspace";
  if (approval === "never" && sandbox === "workspace-write" && network === true)
    return "autonomous-workspace";
  if (approval === "never" && sandbox === "danger-full-access") return "dangerous";
  return "unknown";
}

/** Runs HolyCodex installation and environment health checks. */
export async function doctor(
  home = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  runtime: DoctorRuntime = defaultRuntime,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const pluginRoot = join(home, "plugins", "cache", "holycodex", "holycodex", VERSION);
  const agentRoot = join(home, "holycodex", "agents");
  const configPath = join(home, "config.toml");
  let config = "";
  let configAvailable = true;
  try {
    config = await readFile(configPath, "utf8");
  } catch {
    configAvailable = false;
  }
  const required = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "LICENSE-OH-MY-OPENCODE-SLIM-MIT.txt",
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
          `Plugin ${VERSION}, generated runtime, hooks, three agents, and ${SKILLS.length} skills are present.`,
        )
      : check(
          "package",
          "error",
          "package-incomplete",
          `Missing ${missing.join(", ")}.`,
          "Reinstall HolyCodex.",
        ),
  );

  let mcp: z.infer<typeof McpManifestSchema> | undefined;
  try {
    mcp = McpManifestSchema.parse(
      JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")),
    );
  } catch (error) {
    checks.push(
      check(
        "mcp-config",
        "error",
        "malformed-mcp-config",
        error instanceof z.ZodError
          ? "Invalid MCP JSON structure."
          : error instanceof Error
            ? error.message
            : "Invalid MCP JSON.",
        "Reinstall HolyCodex.",
      ),
    );
  }
  const servers = mcp?.mcpServers;
  const requiredMcps =
    runtime.platform === "win32" ? (["git_bash", "lsp"] as const) : (["lsp"] as const);
  const expectedMcps = effectiveMcpServers(runtime.platform);
  for (const name of requiredMcps) {
    const configured = servers?.[name];
    const expected = expectedMcps[name];
    checks.push(
      configured === undefined || expected === undefined
        ? check(
            `mcp-${name}`,
            "error",
            "missing-required-mcp",
            `${name} is not configured.`,
            "Reinstall HolyCodex.",
          )
        : !mcpConfigMatches(configured, expected)
          ? check(
              `mcp-${name}`,
              "error",
              "invalid-required-mcp-config",
              `${name} configuration is stale or contains unsupported settings.`,
              "Reinstall HolyCodex.",
            )
          : check(`mcp-${name}`, "ok", "required-mcp-ready", `${name} is configured locally.`),
    );
  }
  const codexSlimEdit = servers?.codexslimedit;
  const codexSlimEditConfig = (["bun", "npm"] as const)
    .map((runner) => effectiveMcpServers(runtime.platform, runner).codexslimedit)
    .find((expected) => {
      return (
        expected !== undefined &&
        codexSlimEdit !== undefined &&
        mcpConfigMatches(codexSlimEdit, expected)
      );
    });
  const codexSlimEditStarted =
    codexSlimEditConfig === undefined
      ? undefined
      : await runtime.command(codexSlimEditConfig.command, [
          ...codexSlimEditConfig.args,
          "--version",
        ]);
  checks.push(
    codexSlimEdit === undefined
      ? check(
          "mcp-codexslimedit",
          "error",
          "missing-codexslimedit",
          "codexslimedit is not configured.",
          "Reinstall HolyCodex.",
        )
      : codexSlimEditStarted?.ok === true
        ? check(
            "mcp-codexslimedit",
            "ok",
            "codexslimedit-ready",
            "codexslimedit is configured through npm or Bun.",
          )
        : codexSlimEditConfig === undefined
          ? check(
              "mcp-codexslimedit",
              "error",
              "invalid-codexslimedit-config",
              "codexslimedit configuration is stale or uses an unsupported runner.",
              "Reinstall HolyCodex.",
            )
          : check(
              "mcp-codexslimedit",
              "error",
              "codexslimedit-unavailable",
              `codexslimedit could not start: ${codexSlimEditStarted?.output || "unknown runner error"}`,
              "Check the configured package runner and network access, then reinstall HolyCodex.",
            ),
  );
  const gitBashConfig = servers?.git_bash;
  if (runtime.platform === "win32" && gitBashConfig !== undefined) {
    const expected = effectiveMcpServers("win32").git_bash;
    checks.push(
      expected !== undefined && mcpConfigMatches(gitBashConfig, expected)
        ? check(
            "mcp-git_bash-config",
            "ok",
            "git-bash-mcp-config-ready",
            "Git Bash MCP exposes only run through the supported allowlist.",
          )
        : check(
            "mcp-git_bash-config",
            "error",
            "invalid-git-bash-mcp-config",
            "Git Bash MCP command or enabled_tools configuration is stale.",
            "Reinstall HolyCodex.",
          ),
    );
  } else if (runtime.platform !== "win32" && gitBashConfig !== undefined) {
    checks.push(
      check(
        "mcp-git_bash-config",
        "error",
        "unexpected-git-bash-mcp",
        "Git Bash MCP must not be installed on non-Windows platforms.",
        "Reinstall HolyCodex for this platform.",
      ),
    );
  }

  const context7 = servers?.context7;
  const expectedContext7 = effectiveMcpServers(runtime.platform).context7;
  const obsoleteAuth =
    context7 !== undefined &&
    ["headers", "env", "authorization", "apiKey"].some((key) => key in context7);
  if (context7 === undefined)
    checks.push(
      check(
        "context7-config",
        "error",
        "missing-context7",
        "Context7 is not configured.",
        "Reinstall HolyCodex.",
      ),
    );
  else if (z.string().safeParse(context7.url).success)
    checks.push(
      check(
        "context7-config",
        "error",
        "obsolete-context7-remote",
        "Context7 still uses a hosted URL.",
        "Reinstall to use local bunx Context7.",
      ),
    );
  else if (obsoleteAuth)
    checks.push(
      check(
        "context7-config",
        "error",
        "obsolete-context7-auth",
        "Context7 contains obsolete authentication settings.",
        "Remove auth settings and reinstall.",
      ),
    );
  else if (expectedContext7 === undefined || !mcpConfigMatches(context7, expectedContext7))
    checks.push(
      check(
        "context7-config",
        "error",
        "invalid-context7-config",
        "Context7 launch configuration is stale or contains unsupported settings.",
        "Repair .mcp.json or reinstall.",
      ),
    );
  else
    checks.push(
      check(
        "context7-config",
        "ok",
        "local-context7-config",
        "Local no-auth Context7 is configured.",
      ),
    );

  const bun = await runtime.command("bun", ["--version"]);
  const bunx = await runtime.command("bunx", ["--version"]);
  checks.push(
    bun.ok
      ? check("bun", "ok", "bun-ready", `Bun ${bun.output || "available"}.`)
      : check("bun", "error", "missing-bun", "Bun is unavailable.", "Install or repair Bun."),
  );
  checks.push(
    bunx.ok
      ? check("bunx", "ok", "bunx-ready", `bunx ${bunx.output || "available"}.`)
      : check(
          "bunx",
          "error",
          "missing-bunx",
          "bunx is unavailable.",
          "Repair the Bun installation.",
        ),
  );
  if (bun.ok && bunx.ok && checks.some((item) => item.code === "local-context7-config")) {
    const started = await runtime.context7();
    checks.push(
      started.ok && !started.timedOut
        ? check(
            "context7-startup",
            "ok",
            "context7-healthy",
            "Context7 completed a bounded MCP handshake.",
          )
        : started.packageFailure
          ? check(
              "context7-startup",
              "error",
              "context7-package-resolution-failed",
              started.detail || "Context7 package resolution failed.",
              "Check network/package availability.",
            )
          : check(
              "context7-startup",
              "error",
              "context7-startup-failed",
              started.detail || "Context7 did not complete an MCP handshake within 15 seconds.",
              runtime.platform === "win32"
                ? "Run bunx @upstash/context7-mcp in Git Bash."
                : "Run bunx @upstash/context7-mcp in the native shell.",
            ),
    );
  }

  if (runtime.platform === "win32") {
    const gitBash = runtime.gitBash();
    checks.push(
      gitBash.found
        ? check("git-bash", "ok", "git-bash-ready", `Git Bash: ${gitBash.path ?? "configured"}.`)
        : check(
            "git-bash",
            "error",
            "missing-git-bash",
            "Git Bash is required on Windows but unavailable.",
            gitBash.installHint,
          ),
    );
  } else {
    checks.push(
      check(
        "git-bash",
        "ok",
        "git-bash-not-applicable",
        "Git Bash is not applicable on this platform.",
      ),
    );
  }

  if (!configAvailable) {
    checks.push(
      check(
        "codex-config",
        "error",
        "missing-codex-config",
        `Missing ${configPath}.`,
        "Run holycodex install.",
      ),
    );
  }
  const mode = autonomy(config);
  const plan = readManagedPlan(config);
  checks.push(
    plan === undefined
      ? check(
          "routing-plan",
          "error",
          "routing-plan-missing",
          "No managed model routing plan is recorded.",
          "Rerun holycodex install.",
        )
      : check("routing-plan", "ok", "routing-plan-ready", `Model routing plan ${plan} is active.`),
  );
  const preset = plan === undefined ? undefined : MODEL_ROUTING_PLANS[plan];
  const managedMaxSubagents = readManagedMaxSubagents(config);
  const expectedMaxSubagents = managedMaxSubagents.configured
    ? managedMaxSubagents.value
    : preset?.usage.maxSubagents;
  const rootOverrides = readPreservedRootOverrides(config);
  checks.push(
    preset !== undefined &&
      rootTomlString(config, "model") === preset.root.model &&
      rootTomlString(config, "model_reasoning_effort") === preset.root.reasoningEffort
      ? check(
          "root-model",
          "ok",
          "root-model-ready",
          "Root model matches the selected routing plan.",
        )
      : rootOverrides.model || rootOverrides.reasoningEffort
        ? check(
            "root-model",
            "ok",
            "root-model-override",
            "Root model uses an intentionally preserved explicit override.",
          )
        : check(
            "root-model",
            "error",
            "root-model-stale",
            "Root model configuration does not match the selected routing plan.",
            "Reinstall HolyCodex.",
          ),
  );
  checks.push(
    preset === undefined ||
      expectedMaxSubagents === undefined ||
      tableInteger(config, "agents", "max_threads") !== expectedMaxSubagents + 1 ||
      tableInteger(config, "agents", "max_depth") !== preset.usage.maxDepth
      ? check(
          "agent-usage",
          "error",
          "agent-usage-stale",
          "Agent concurrency configuration does not match the selected routing plan or explicit override.",
          "Reinstall HolyCodex.",
        )
      : check(
          "agent-usage",
          "ok",
          "agent-usage-ready",
          `Agent concurrency allows ${expectedMaxSubagents} direct subagent${expectedMaxSubagents === 1 ? "" : "s"}.`,
        ),
  );
  checks.push(
    mode === "unknown"
      ? check(
          "autonomy",
          "error",
          "invalid-autonomy-config",
          "Approval, sandbox, and network settings do not match a supported mode.",
          "Rerun install with the intended autonomy flag.",
        )
      : mode === "dangerous"
        ? check(
            "autonomy",
            "warning",
            "dangerous-autonomy",
            "Explicit dangerous autonomy is active; workspace containment is removed.",
          )
        : check(
            "autonomy",
            "ok",
            `${mode}-ready`,
            mode === "safe-workspace"
              ? "Safe workspace autonomy is active."
              : "Approval-free workspace autonomy is active.",
          ),
  );
  checks.push(
    tableBoolean(config, "features", "default_mode_request_user_input") === true
      ? check("user-input", "ok", "user-input-ready", "default_mode_request_user_input is enabled.")
      : check(
          "user-input",
          "error",
          "user-input-disabled",
          "default_mode_request_user_input is not enabled.",
          "Rerun holycodex install.",
        ),
  );
  checks.push(
    rootTomlStringArray(config, "status_line")?.includes("context-remaining") === true
      ? check(
          "context-visibility",
          "warning",
          "context-visible-support-unverified",
          "status_line includes context-remaining. Current official Codex config documents this item, but publishes no minimum compatible Codex version.",
        )
      : check(
          "context-visibility",
          "error",
          "context-hidden",
          "status_line does not include context-remaining.",
          "Rerun holycodex install.",
        ),
  );
  const codex = await runtime.command("codex", ["--version"]);
  checks.push(
    codex.ok
      ? check("codex", "ok", "codex-version", codex.output || "Codex is available.")
      : check(
          "codex",
          "warning",
          "codex-version-unavailable",
          "Codex version could not be read; status-line compatibility cannot be independently confirmed.",
        ),
  );

  const agentModelFailures: string[] = [];
  for (const agent of AGENTS) {
    try {
      const text = await readFile(join(agentRoot, `${agent}.toml`), "utf8");
      const expected = plan === undefined ? undefined : MODEL_ROUTING_PLANS[plan].agents[agent];
      if (
        expected === undefined ||
        rootTomlString(text, "model") !== expected.model ||
        rootTomlString(text, "model_reasoning_effort") !== expected.reasoningEffort
      )
        agentModelFailures.push(agent);
    } catch {
      agentModelFailures.push(agent);
    }
  }
  checks.push(
    agentModelFailures.length === 0
      ? check(
          "agent-models",
          "ok",
          "agent-models-ready",
          `Specialist models match the ${plan ?? "unknown"} routing plan.`,
        )
      : check(
          "agent-models",
          "error",
          "agent-models-stale",
          `Agent model configuration is stale for ${agentModelFailures.join(", ")}.`,
          "Reinstall HolyCodex.",
        ),
  );

  return { healthy: !checks.some((item) => item.status === "error"), autonomy: mode, checks };
}
