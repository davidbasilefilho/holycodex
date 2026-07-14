import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LSP_MCP_TOOLS } from "../packages/lsp-core/src/tools";
import { handleGitBashMcpRequest } from "../packages/git-bash-mcp/src/mcp";

const root = join(import.meta.dirname, "..");
const skills = [
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
  "remove-ai-slops",
  "rules",
  "security-research",
] as const;
const responseStyleContract = [
  "Default user-facing replies: grammatical sentences; no filler or hedging.",
  "Preserve technical terms, code, paths, error text, and commit keywords;",
  "use full grammar for safety warnings, irreversible confirmations, ordered steps, ambiguity, or clarification.",
] as const;

describe("HolyCodex catalog", () => {
  it("uses the HolyCodex marketplace label", async () => {
    const marketplace = JSON.parse(await readFile(join(root, "marketplace.json"), "utf8")) as {
      name: string;
      interface?: { displayName?: string };
    };
    expect(marketplace.name).toBe("HolyCodex");
    expect(marketplace.interface?.displayName).toBe("HolyCodex");
  });

  it("ships only routed skills and three described agents", async () => {
    expect((await readdir(join(root, "plugin", "skills"))).sort()).toEqual([...skills].sort());
    for (const skill of skills) {
      const text = await readFile(join(root, "plugin", "skills", skill, "SKILL.md"), "utf8");
      expect(text).toMatch(/^description: Use when /m);
      const description = text.match(/^description:\s*(.*)$/m)?.[1] ?? "";
      expect(description).toMatch(/do not|only when|only after|before editing/i);
      expect(description).toMatch(/Produces|Applies|Creates|Returns/i);
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
      expect(prompt).toContain(
        "Before any plan, skill routing, or task action, inspect the full callable tool registry, including deferred tools",
      );
      expect(prompt).toContain("treat only that registry as availability evidence");
      expect(prompt).toContain("On native Windows, before any shell call");
      expect(prompt).toContain("resolve `mcp__git_bash__run` from the full callable registry");
      expect(prompt).toContain("including deferred tools");
      expect(prompt).toContain("otherwise use native shell directly");
      for (const rule of responseStyleContract) expect(prompt).toContain(rule);
      expect(prompt).not.toMatch(/delegat|subagent/i);
      expect(prompt).toContain("Accept one task packet containing exact");
      expect(prompt).toContain("repository root");
      expect(prompt).toContain("allowed paths");
      expect(prompt).toContain("forbidden paths");
      expect(prompt).toContain("relevant architecture and existing behavior");
      expect(prompt).toContain("required skills");
      expect(prompt).toContain("exact inputs");
      expect(prompt).toContain("output format");
      expect(prompt).toContain("acceptance criteria");
      expect(prompt).toContain("required commands or evidence");
      expect(prompt).toContain("unchanged constraints");
      expect(prompt).toContain("prohibited expansion");
      expect(prompt).toContain("known uncertainty");
      expect(prompt).toContain("blocker behavior");
      expect(prompt).toContain("stop condition");
      expect(prompt).toContain("Return exactly requested format");
      expect(prompt).toContain("no proposed extra work");
    }
    expect(await readFile(join(root, "plugin", "agents", "explorer.toml"), "utf8")).toContain(
      'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"',
    );
    expect(await readFile(join(root, "plugin", "agents", "librarian.toml"), "utf8")).toContain(
      'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"',
    );
    expect(await readFile(join(root, "plugin", "agents", "worker.toml"), "utf8")).toContain(
      'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"',
    );
    expect(await readFile(join(root, "plugin", "agents", "worker.toml"), "utf8")).toContain(
      "Prompt, skill, or instruction task: load caveman first; preserve constraints.",
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

  it("keeps plugin routing ownership explicit", async () => {
    const manifest = JSON.parse(
      await readFile(join(root, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
    ) as { interface?: { longDescription?: string } };
    const description = manifest.interface?.longDescription ?? "";
    expect(description).toContain("Skills own their declared methods and gates");
    expect(description).toContain("main agent owns decisions, integration, and verification");
    expect(description).toContain("do not delegate trivial, coupled, ambiguous, architectural");
  });

  it("gives every local MCP tool invocation guidance", async () => {
    for (const tool of LSP_MCP_TOOLS) expect(tool.description).toMatch(/^Use /);
    const response = await handleGitBashMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { platform: "linux", env: {}, exists: () => false, where: () => [] },
    );
    if (response === undefined || "error" in response || response.result === undefined)
      throw new Error("tools/list failed");
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
