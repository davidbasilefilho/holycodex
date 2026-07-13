import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LSP_MCP_TOOLS } from "../packages/lsp-core/src/tools";
import { handleGitBashMcpRequest } from "../packages/git-bash-mcp/src/mcp";

const root = join(import.meta.dirname, "..");
const skills = [
  "ast-grep",
  "caveman",
  "comment-checker",
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
  "remove-ai-slops",
  "rules",
  "security-research",
  "tdd",
] as const;

describe("HolyCodex catalog", () => {
  it("ships only routed skills and three described agents", async () => {
    expect((await readdir(join(root, "plugin", "skills"))).sort()).toEqual([...skills].sort());
    for (const skill of skills) {
      const text = await readFile(join(root, "plugin", "skills", skill, "SKILL.md"), "utf8");
      expect(text).toMatch(/^description:\s*(?:>|.*(?:Use|use|Explicit request))/m);
    }
    expect((await readdir(join(root, "plugin", "agents"))).sort()).toEqual([
      "explorer.toml",
      "librarian.toml",
      "worker.toml",
    ]);
    for (const agent of await readdir(join(root, "plugin", "agents"))) {
      const prompt = await readFile(join(root, "plugin", "agents", agent), "utf8");
      expect(prompt).toMatch(/^description = ".*Use .*"$/m);
      expect(prompt).toContain('Start: "I detect ');
      expect(prompt).toContain("Use git_bash MCP for every shell command.");
      expect(prompt).not.toContain("Delegate bounded labor");
    }
    expect(await readFile(join(root, "plugin", "agents", "worker.toml"), "utf8")).toContain(
      "Prompt, skill, or instruction task: load caveman skill first; write terse without losing constraints.",
    );
  });

  it("pins activation phrases and enables every MCP default", async () => {
    const expected = new Map([
      ["define-goal", "**GOAL MODE ACTIVATED**"],
      ["plan", "**PLAN MODE ACTIVATED**"],
      ["plan-review", "**PLAN REVIEW ACTIVATED**"],
    ]);
    for (const [skill, phrase] of expected) {
      expect(await readFile(join(root, "plugin", "skills", skill, "SKILL.md"), "utf8")).toContain(
        phrase,
      );
    }
    const plugin = JSON.parse(
      await readFile(join(root, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
    ) as { mcpServers?: unknown };
    expect(plugin.mcpServers).toBe("./.mcp.json");

    const manifest = JSON.parse(await readFile(join(root, "plugin", ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command?: string; args?: string[]; cwd?: string; url?: string }>;
    };
    expect(manifest.mcpServers).toEqual({
      git_bash: { command: "node", args: ["runtime/git-bash.js", "mcp"], cwd: "." },
      lsp: { command: "node", args: ["runtime/lsp.js", "mcp"], cwd: "." },
      grep_app: { url: "https://mcp.grep.app" },
      context7: { url: "https://mcp.context7.com/mcp" },
    });
    await Promise.all(
      ["git-bash.js", "lsp.js"].map((file) =>
        readFile(join(root, "plugin", "runtime", file), "utf8"),
      ),
    );
    expect((await readdir(join(root, "plugin", "runtime"))).sort()).toEqual(
      [
        "bootstrap.js",
        "cli.js",
        "core-instructions.js",
        "git-bash.js",
        "lsp.js",
        "mcp-stdio-core.js",
        "rules.js",
      ].sort(),
    );
  });

  it("gives every local MCP tool invocation guidance", async () => {
    for (const tool of LSP_MCP_TOOLS) expect(tool.description).toMatch(/^Use /);
    const response = await handleGitBashMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { platform: "linux", env: {}, exists: () => false, where: () => [] },
    );
    if (response === undefined || "error" in response) throw new Error("tools/list failed");
    const tools = response.result.tools as Array<{ description: string }>;
    for (const tool of tools) expect(tool.description).toMatch(/^Use /);
  });

  it("ships only supported command hooks", async () => {
    const config = JSON.parse(
      await readFile(join(root, "plugin", "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ type: string }> }>> };
    const hookTypes = Object.values(config.hooks)
      .flat()
      .flatMap((group) => group.hooks.map((hook) => hook.type));
    expect(hookTypes).not.toContain("prompt");
    expect(new Set(hookTypes)).toEqual(new Set(["command"]));
  });
});
