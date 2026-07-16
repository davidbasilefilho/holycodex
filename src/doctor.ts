import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../packages/git-bash-mcp/src/git-bash-resolver.ts";

const VERSION = "0.5.3";
const AGENTS = ["explorer", "librarian", "worker"] as const;
const RUNTIMES = [
  "bootstrap.js",
  "cli.js",
  "core-instructions.js",
  "git-bash.js",
  "git-bash-resolver.js",
  "lsp.js",
  "mcp-stdio-core.js",
  "rules.js",
] as const;
const SKILLS = [
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
  readonly packageFailure: boolean;
  readonly detail: string;
};
export type DoctorRuntime = {
  readonly command: (name: string, args: readonly string[]) => Promise<CommandResult>;
  readonly context7: () => Promise<Context7Result>;
  readonly gitBash: () => GitBashResolution;
};

function runCommand(name: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", (error) => resolve({ ok: false, output: error.message }));
    child.once("exit", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

function startContext7(): Promise<Context7Result> {
  return new Promise((resolve) => {
    const child = spawn("bunx", ["@upstash/context7-mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let diagnostic = "";
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      const packageFailure = /(?:404|failed to resolve|package.*not found|error: GET)/i.test(
        diagnostic,
      );
      resolve({ ok, packageFailure, detail: diagnostic.trim() });
    };
    const timer = setTimeout(() => finish(false), 15_000);
    child.once("error", (error) => {
      diagnostic += error.message;
      finish(false);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      diagnostic += output;
      if (output.includes('"serverInfo"') || output.includes('"capabilities"')) finish(true);
    });
    child.stdin.end(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "holycodex-doctor", version: VERSION } } })}\n`,
    );
  });
}

const defaultRuntime: DoctorRuntime = {
  command: runCommand,
  context7: startContext7,
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

function rootString(config: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(config)?.[1];
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

function autonomy(config: string): DoctorResult["autonomy"] {
  const approval = rootString(config, "approval_policy");
  const sandbox = rootString(config, "sandbox_mode");
  const network = tableBoolean(config, "sandbox_workspace_write", "network_access");
  if (approval === "on-request" && sandbox === "workspace-write" && network === true)
    return "safe-workspace";
  if (approval === "never" && sandbox === "workspace-write" && network === true)
    return "autonomous-workspace";
  if (approval === "never" && sandbox === "danger-full-access") return "dangerous";
  return "unknown";
}

export async function doctor(
  home = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  runtime: DoctorRuntime = defaultRuntime,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const pluginRoot = join(home, "plugins", "cache", "holycodex", "holycodex", VERSION);
  const configPath = join(home, "config.toml");
  const required = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "LICENSE-OH-MY-OPENCODE-SLIM-MIT.txt",
    "hooks/hooks.json",
    ...RUNTIMES.map((file) => `runtime/${file}`),
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

  let mcp: { readonly mcpServers?: Record<string, Record<string, unknown>> } | undefined;
  try {
    mcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as typeof mcp;
  } catch (error) {
    checks.push(
      check(
        "mcp-config",
        "error",
        "malformed-mcp-config",
        error instanceof Error ? error.message : "Invalid MCP JSON.",
        "Reinstall HolyCodex.",
      ),
    );
  }
  const servers = mcp?.mcpServers;
  for (const name of ["git_bash", "lsp"] as const)
    checks.push(
      servers?.[name] === undefined
        ? check(
            `mcp-${name}`,
            "error",
            "missing-required-mcp",
            `${name} is not configured.`,
            "Reinstall HolyCodex.",
          )
        : check(`mcp-${name}`, "ok", "required-mcp-ready", `${name} is configured locally.`),
    );

  const context7 = servers?.context7;
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
  else if (typeof context7.url === "string")
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
  else if (
    context7.command !== "bunx" ||
    JSON.stringify(context7.args) !== JSON.stringify(["@upstash/context7-mcp"])
  )
    checks.push(
      check(
        "context7-config",
        "error",
        "wrong-context7-package",
        "Expected bunx @upstash/context7-mcp.",
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
      started.ok
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
              "Run bunx @upstash/context7-mcp in Git Bash.",
            ),
    );
  }

  const gitBash = runtime.gitBash();
  checks.push(
    gitBash.found
      ? check(
          "git-bash",
          "ok",
          "git-bash-ready",
          gitBash.path === null
            ? "Git Bash is not required on this platform."
            : `Git Bash: ${gitBash.path}.`,
        )
      : check(
          "git-bash",
          "error",
          "missing-git-bash",
          "Git Bash is required on Windows but unavailable.",
          gitBash.installHint,
        ),
  );

  let config = "";
  try {
    config = await readFile(configPath, "utf8");
  } catch {
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
    /^\s*status_line\s*=\s*\[[\s\S]*?context-remaining[\s\S]*?]/m.test(config)
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

  return { healthy: !checks.some((item) => item.status === "error"), autonomy: mode, checks };
}
