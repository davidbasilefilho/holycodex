import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENTS,
  MODEL_ROUTING_PLANS,
  effectiveMcpServers,
  VERSION,
} from "../packages/cli/src/catalog";
import { installConfig, type AutonomyMode } from "../packages/cli/src/config";
import { doctor, type DoctorRuntime } from "../packages/cli/src/doctor";

const root = join(import.meta.dirname, "..");
const gitBashReady = { found: true, path: null, source: "not-required", checkedPaths: [] } as const;

function runtime(overrides: Partial<DoctorRuntime> = {}): DoctorRuntime {
  return {
    platform: "win32",
    command: async (name) => ({
      ok: true,
      output: name === "codex" ? "codex-cli 1.2.3" : "1.3.14",
    }),
    context7: async () => ({ ok: true, timedOut: false, packageFailure: false, detail: "" }),
    gitBash: () => gitBashReady,
    ...overrides,
  };
}

async function fixture(mode: AutonomyMode = "default"): Promise<{ home: string; plugin: string }> {
  const home = await mkdtemp(join(tmpdir(), "holycodex-doctor-"));
  const plugin = join(home, "plugins", "cache", "holycodex", "holycodex", VERSION);
  await mkdir(join(plugin, ".."), { recursive: true });
  await cp(join(root, "packages", "plugin", "plugin"), plugin, { recursive: true });
  await cp(join(plugin, "agents"), join(home, "holycodex", "agents"), { recursive: true });
  await writeFile(join(home, "config.toml"), installConfig("", mode, "win32"));
  await Promise.all(
    AGENTS.map((agent) => {
      const route = MODEL_ROUTING_PLANS.plus.agents[agent];
      return writeFile(
        join(home, "holycodex", "agents", `${agent}.toml`),
        `model = "${route.model}"\nmodel_reasoning_effort = "${route.reasoningEffort}"\n`,
      );
    }),
  );
  return { home, plugin };
}

function codes(result: Awaited<ReturnType<typeof doctor>>): string[] {
  return result.checks.map((item) => item.code);
}

describe("HolyCodex doctor", () => {
  it("reports comprehensive healthy state", async () => {
    const { home } = await fixture();
    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(true);
    expect(result.autonomy).toBe("safe-workspace");
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "package-ready",
        "required-mcp-ready",
        "codexslimedit-ready",
        "local-context7-config",
        "bun-ready",
        "bunx-ready",
        "context7-healthy",
        "git-bash-ready",
        "safe-workspace-ready",
        "user-input-ready",
        "context-visible-support-unverified",
        "codex-version",
      ]),
    );
  });

  it("checks active agent models instead of the pristine package cache", async () => {
    const { home } = await fixture();
    await writeFile(
      join(home, "holycodex", "agents", "explorer.toml"),
      'model = "user/model"\nmodel_reasoning_effort = "high"\n',
    );
    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(false);
    expect(codes(result)).toContain("agent-models-stale");
  });

  it("accepts original and managed-block root overrides", async () => {
    const original = await fixture();
    await writeFile(
      join(original.home, "config.toml"),
      installConfig('model = "user/root"\nmodel_reasoning_effort = "high"\n', "default", "win32"),
    );
    const originalResult = await doctor(original.home, runtime());
    expect(originalResult.healthy).toBe(true);
    expect(codes(originalResult)).toContain("root-model-override");

    const edited = await fixture();
    const configPath = join(edited.home, "config.toml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace('model = "gpt-5.6-sol"', 'model = "user/root"'),
    );
    const editedResult = await doctor(edited.home, runtime());
    expect(editedResult.healthy).toBe(true);
    expect(codes(editedResult)).toContain("root-model-override");
  });

  it("reports missing or corrupt managed root routing and stale plan usage controls", async () => {
    const { home } = await fixture();
    const configPath = join(home, "config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config
        .replace('model = "gpt-5.6-sol"', "model = [")
        .replace("max_threads = 2", "max_threads = 7")
        .replace("max_depth = 1", "max_depth = 3"),
    );
    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining(["root-model-stale", "agent-usage-stale"]),
    );

    const missing = await fixture();
    const missingPath = join(missing.home, "config.toml");
    await writeFile(
      missingPath,
      (await readFile(missingPath, "utf8")).replace(/^model_reasoning_effort = .*\n/m, ""),
    );
    expect(codes(await doctor(missing.home, runtime()))).toContain("root-model-stale");
  });

  it("ignores commented defaults when checking active agent models", async () => {
    const { home } = await fixture();
    await writeFile(
      join(home, "holycodex", "agents", "explorer.toml"),
      '# model = "gpt-5.6-luna"\nmodel = "user/model"\n# model_reasoning_effort = "low"\nmodel_reasoning_effort = "high"\n',
    );
    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(false);
    expect(codes(result)).toContain("agent-models-stale");
    expect(codes(result)).not.toContain("agent-models-ready");
  });

  it("does not read autonomy settings from named tables", async () => {
    const { home } = await fixture();
    await writeFile(
      join(home, "config.toml"),
      '[profiles.safe]\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nnetwork_access = true\n',
    );
    const result = await doctor(home, runtime());
    expect(result.autonomy).toBe("unknown");
    expect(codes(result)).toContain("invalid-autonomy-config");
  });

  it("warns without failing for explicitly dangerous autonomy", async () => {
    const { home } = await fixture("dangerous");
    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(true);
    expect(result.autonomy).toBe("dangerous");
    expect(codes(result)).toContain("dangerous-autonomy");
  });

  it("distinguishes missing Bun and bunx", async () => {
    const { home } = await fixture();
    const result = await doctor(
      home,
      runtime({ command: async (name) => ({ ok: name === "codex", output: "" }) }),
    );
    expect(result.healthy).toBe(false);
    expect(codes(result)).toEqual(expect.arrayContaining(["missing-bun", "missing-bunx"]));
    expect(codes(result)).not.toContain("context7-healthy");
  });

  it("distinguishes malformed and obsolete Context7 configuration", async () => {
    const malformed = await fixture();
    await writeFile(join(malformed.plugin, ".mcp.json"), "{");
    expect(codes(await doctor(malformed.home, runtime()))).toContain("malformed-mcp-config");

    const obsolete = await fixture();
    const mcpPath = join(obsolete.plugin, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: { context7: Record<string, unknown> };
    };
    mcp.mcpServers.context7 = {
      command: "bunx",
      args: ["@upstash/context7-mcp"],
      headers: { Authorization: "redacted" },
    };
    await writeFile(mcpPath, JSON.stringify(mcp));
    expect(codes(await doctor(obsolete.home, runtime()))).toContain("obsolete-context7-auth");
  });

  it("rejects unsupported Context7 launch settings", async () => {
    const { home, plugin } = await fixture();
    const mcpPath = join(plugin, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: { context7: Record<string, unknown> };
    };
    mcp.mcpServers.context7.cwd = "/missing";
    await writeFile(mcpPath, JSON.stringify(mcp));

    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(false);
    expect(codes(result)).toContain("invalid-context7-config");
    expect(codes(result)).not.toContain("context7-healthy");
  });

  it("distinguishes package resolution from startup failure", async () => {
    const first = await fixture();
    const packageFailure = runtime({
      context7: async () => ({
        ok: false,
        timedOut: false,
        packageFailure: true,
        detail: "package not found",
      }),
    });
    expect(codes(await doctor(first.home, packageFailure))).toContain(
      "context7-package-resolution-failed",
    );

    const second = await fixture();
    const startupFailure = runtime({
      context7: async () => ({
        ok: false,
        timedOut: false,
        packageFailure: false,
        detail: "handshake timeout",
      }),
    });
    expect(codes(await doctor(second.home, startupFailure))).toContain("context7-startup-failed");
  });

  it("rejects a Context7 handshake that matched after timing out", async () => {
    const { home } = await fixture();
    const result = await doctor(
      home,
      runtime({
        context7: async () => ({
          ok: true,
          timedOut: true,
          packageFailure: false,
          detail: "late handshake",
        }),
      }),
    );
    expect(codes(result)).toContain("context7-startup-failed");
    expect(codes(result)).not.toContain("context7-healthy");
  });

  it("rejects stale LSP configuration", async () => {
    const { home, plugin } = await fixture();
    const mcpPath = join(plugin, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    mcp.mcpServers.lsp = { command: "node", args: ["runtime/missing-lsp.js", "mcp"], cwd: "." };
    await writeFile(mcpPath, JSON.stringify(mcp));

    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(false);
    expect(result.checks.find((check) => check.id === "mcp-lsp")?.code).toBe(
      "invalid-required-mcp-config",
    );
  });

  it("accepts npm CodexSlimEdit configuration and rejects stale launch settings", async () => {
    const npmFixture = await fixture();
    const npmMcpPath = join(npmFixture.plugin, ".mcp.json");
    const npmMcp = JSON.parse(await readFile(npmMcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    npmMcp.mcpServers.codexslimedit = effectiveMcpServers("win32", "npm").codexslimedit ?? {};
    await writeFile(npmMcpPath, JSON.stringify(npmMcp));
    expect(codes(await doctor(npmFixture.home, runtime()))).toContain("codexslimedit-ready");

    const staleFixture = await fixture();
    const staleMcpPath = join(staleFixture.plugin, ".mcp.json");
    const staleMcp = JSON.parse(await readFile(staleMcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    staleMcp.mcpServers.codexslimedit = { command: "npx", args: ["codexslimedit"] };
    await writeFile(staleMcpPath, JSON.stringify(staleMcp));
    expect(codes(await doctor(staleFixture.home, runtime()))).toContain(
      "invalid-codexslimedit-config",
    );
  });

  it("accepts reordered Git Bash configuration keys", async () => {
    const { home, plugin } = await fixture();
    const mcpPath = join(plugin, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    mcp.mcpServers.git_bash = {
      enabled_tools: ["run"],
      cwd: ".",
      args: ["runtime/git-bash.js", "mcp"],
      command: "node",
    };
    await writeFile(mcpPath, JSON.stringify(mcp));

    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(true);
    expect(codes(result)).toContain("git-bash-mcp-config-ready");
  });

  it("ignores commented status-line items", async () => {
    const { home } = await fixture();
    await writeFile(
      join(home, "config.toml"),
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\nstatus_line = [\n  # "context-remaining"\n]\n\n[sandbox_workspace_write]\nnetwork_access = true\n\n[features]\ndefault_mode_request_user_input = true\n',
    );
    const result = await doctor(home, runtime());
    expect(codes(result)).toContain("context-hidden");
    expect(codes(result)).not.toContain("context-visible-support-unverified");
  });

  it("reports package, Git Bash, config, feature, and visibility failures", async () => {
    const { home, plugin } = await fixture();
    await rm(join(plugin, "runtime", "lsp.js"));
    await writeFile(
      join(home, "config.toml"),
      'approval_policy = "never"\nsandbox_mode = "workspace-write"\n',
    );
    const gitBashMissing = runtime({
      gitBash: () => ({ found: false, checkedPaths: [], installHint: "Install Git Bash." }),
    });
    const result = await doctor(home, gitBashMissing);
    expect(result.healthy).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "package-incomplete",
        "missing-git-bash",
        "invalid-autonomy-config",
        "user-input-disabled",
        "context-hidden",
      ]),
    );
  });

  it("treats Git Bash as not applicable off Windows", async () => {
    const { home, plugin } = await fixture();
    await rm(join(plugin, "runtime", "git-bash.js"));
    await writeFile(
      join(plugin, ".mcp.json"),
      JSON.stringify({ mcpServers: effectiveMcpServers("linux") }),
    );
    const result = await doctor(
      home,
      runtime({
        platform: "linux",
        gitBash: () => ({ found: false, checkedPaths: [], installHint: "irrelevant" }),
      }),
    );
    expect(result.healthy).toBe(true);
    expect(codes(result)).toContain("git-bash-not-applicable");
    expect(codes(result)).not.toContain("missing-required-mcp");
    expect(codes(result)).not.toContain("missing-git-bash");
  });
});
