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
      expect(await readFile(join(root, "plugin", "agents", agent), "utf8")).toMatch(
        /^description = ".*Use .*"$/m,
      );
    }
  });

  it("pins activation phrases and four MCP defaults", async () => {
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
    const manifest = JSON.parse(await readFile(join(root, "plugin", ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(manifest.mcpServers).sort()).toEqual([
      "context7",
      "git_bash",
      "grep_app",
      "lsp",
    ]);
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
});
