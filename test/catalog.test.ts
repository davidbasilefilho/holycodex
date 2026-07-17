import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LSP_MCP_TOOLS } from "../packages/lsp-core/src/tools";
import { handleGitBashMcpRequest } from "../packages/git-bash-mcp/src/mcp";
import {
  AGENT_MODELS,
  AGENTS,
  effectiveMcpServers,
  GENERATED_RUNTIMES,
  requiredPackageRuntimes,
  ROOT_MODEL,
  SKILLS,
  VERSION,
} from "../packages/cli/src/catalog";

const root = join(import.meta.dirname, "..");
const pluginRoot = join(root, "packages", "plugin", "plugin");
const skills = SKILLS;
const responseStyleContract = [
  "Default user-facing replies: grammatical sentences; no filler or hedging.",
  "Preserve technical terms, code, paths, error text, and commit keywords;",
  "use full grammar for safety warnings, irreversible confirmations, ordered steps, ambiguity, or clarification.",
] as const;

describe("HolyCodex catalog", () => {
  it("keeps version and model defaults in the canonical catalogue", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      version: string;
    };
    const plugin = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { version: string };
    expect(packageJson.version).toBe(VERSION);
    expect(plugin.version).toBe(VERSION);
    expect(ROOT_MODEL).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "medium" });
    expect(AGENT_MODELS.worker).toEqual({
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
  });

  it("retains the shared Git Bash resolver in non-Windows packages", () => {
    expect(requiredPackageRuntimes("linux")).toContain("git-bash-resolver.js");
    expect(requiredPackageRuntimes("linux")).not.toContain("git-bash.js");
  });

  it("uses the HolyCodex marketplace label", async () => {
    const marketplace = JSON.parse(await readFile(join(root, "marketplace.json"), "utf8")) as {
      name: string;
      interface?: { displayName?: string };
    };
    expect(marketplace.name).toBe("HolyCodex");
    expect(marketplace.interface?.displayName).toBe("HolyCodex");
  });

  it("ships only routed skills and three described agents", async () => {
    expect((await readdir(join(pluginRoot, "skills"))).sort()).toEqual([...skills].sort());
    for (const skill of skills) {
      const text = await readFile(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(text).toMatch(/^description: Use when /m);
      const description = text.match(/^description:\s*(.*)$/m)?.[1] ?? "";
      expect(description).toMatch(/do not|only when|only after|before editing/i);
      expect(description).toMatch(/Produces|Applies|Creates|Returns/i);
    }
    expect((await readdir(join(pluginRoot, "agents"))).sort()).toEqual([
      "explorer.toml",
      "librarian.toml",
      "worker.toml",
    ]);
    for (const agent of await readdir(join(pluginRoot, "agents"))) {
      const prompt = await readFile(join(pluginRoot, "agents", agent), "utf8");
      expect(prompt).toMatch(/^description = ".*Use .*"$/m);
      expect(prompt).toContain('Start: "I detect ');
      expect(prompt).toContain("before the first shell action");
      expect(prompt).toContain("callable and deferred tools");
      expect(prompt).toContain("Use it for every shell command");
      expect(prompt).toContain("If unavailable, stop and report the blocker");
      for (const rule of responseStyleContract) expect(prompt).toContain(rule);
      expect(prompt).toMatch(/Accept one (?:bounded|coherent) packet containing exact/);
      expect(prompt).toContain("allowed scope");
      expect(prompt).toContain("unchanged constraints");
      expect(prompt).toContain("forbidden expansion");
      expect(prompt).toContain("acceptance evidence");
      expect(prompt).toContain("blocker behavior");
      expect(prompt).toContain("exact stop condition");
      expect(prompt).toContain("only when relevant");
      expect(prompt).toContain("irrelevant optional field");
      expect(prompt).toContain("propose no extra work");
      expect(prompt).toContain("or delegate");
    }
    for (const agent of AGENTS) {
      const text = await readFile(join(pluginRoot, "agents", `${agent}.toml`), "utf8");
      expect(text).toContain(`model = "${AGENT_MODELS[agent].model}"`);
      expect(text).toContain(`model_reasoning_effort = "${AGENT_MODELS[agent].reasoningEffort}"`);
    }
    expect(await readFile(join(pluginRoot, "agents", "worker.toml"), "utf8")).toContain(
      "For prompt or instruction work, load caveman first.",
    );
  });

  it("pins activation phrases and enables every MCP default", async () => {
    const expected = new Map([
      ["define-goal", "**GOAL MODE ACTIVATED**"],
      ["plan", "**PLAN MODE ACTIVATED**"],
      ["plan-review", "**PLAN REVIEW MODE ACTIVATED**"],
    ]);
    for (const [skill, phrase] of expected) {
      expect(await readFile(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8")).toContain(
        phrase,
      );
    }
    const plugin = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { mcpServers?: unknown };
    expect(plugin.mcpServers).toBe("./.mcp.json");

    const manifest = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(manifest.mcpServers).toEqual(effectiveMcpServers("win32"));
    await Promise.all(
      ["git-bash.js", "lsp.js"].map((file) => readFile(join(pluginRoot, "runtime", file), "utf8")),
    );
    expect((await readdir(join(pluginRoot, "runtime"))).sort()).toEqual(
      [...GENERATED_RUNTIMES].sort(),
    );
  });

  it("keeps plugin routing ownership explicit", async () => {
    const manifest = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { interface?: { longDescription?: string } };
    const description = manifest.interface?.longDescription ?? "";
    expect(description).toContain("Root remains the default user-facing agent");
    expect(description).toContain("cost-aware decomposition");
    expect(description).toContain("Luna low");
    expect(description).toContain("Terra high");
    expect(description).toContain("mandatory only on native Windows");
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
    const config = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string }> }>>;
    };
    const hookTypes = Object.values(config.hooks)
      .flat()
      .flatMap((group) => group.hooks.map((hook) => hook.type));
    expect(hookTypes).not.toContain("prompt");
    expect(new Set(hookTypes)).toEqual(new Set(["command"]));
  });
});
