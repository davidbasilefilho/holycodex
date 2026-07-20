import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_MODELS,
  AGENTS,
  DEFAULT_PLAN,
  effectiveMcpServers,
  GENERATED_RUNTIMES,
  MODEL_ROUTING_PLANS,
  ModelRoutingPlansSchema,
  PLAN_NAMES,
  PlanNameSchema,
  ReasoningEffortSchema,
  requiredPackageRuntimes,
  ROOT_MODEL,
  SKILLS,
  VERSION,
} from "../packages/cli/src/catalog";
import { rootTomlString } from "../packages/cli/src/toml";
import { handleGitBashMcpRequest } from "../packages/git-bash-mcp/src/mcp";
import { LSP_MCP_TOOLS } from "../packages/lsp-core/src/tools";

const root = join(import.meta.dirname, "..");
const pluginRoot = join(root, "packages", "plugin", "plugin");
const skills = SKILLS;
const responseStyleContract = [
  "Use grammatical sentences without filler or hedging.",
  "Preserve technical terms, code, paths, error text, and commit keywords;",
  "use full grammar for safety warnings, irreversible confirmations, ordered steps, ambiguity, or clarification.",
] as const;
const specialistPacketConcepts = [
  "exact outcome or question",
  "allowed scope",
  "constraints and fixed decisions",
  "required evidence or proof",
  "stop and blocker conditions",
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
    expect(ROOT_MODEL).toBe(MODEL_ROUTING_PLANS.plus.root);
    expect(AGENT_MODELS).toBe(MODEL_ROUTING_PLANS.plus.agents);
  });

  it("retains the shared Git Bash resolver in non-Windows packages", () => {
    expect(requiredPackageRuntimes("linux")).toContain("git-bash-resolver.js");
    expect(requiredPackageRuntimes("linux")).not.toContain("git-bash.js");
  });

  it("defines the ordered six-tier routing plan without unsupported reasoning", () => {
    expect(PLAN_NAMES).toEqual(["go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"]);
    expect(Object.keys(MODEL_ROUTING_PLANS)).toEqual(PLAN_NAMES);
    expect(
      Object.values(MODEL_ROUTING_PLANS).every((preset) =>
        AGENTS.every((agent) => preset.agents[agent]),
      ),
    ).toBe(true);
    expect(JSON.stringify(MODEL_ROUTING_PLANS)).not.toContain('"max"');
    expect(
      Object.values(MODEL_ROUTING_PLANS).every((preset) => preset.root.model === "gpt-5.6-sol"),
    ).toBe(true);
    expect(Object.values(MODEL_ROUTING_PLANS).every((preset) => preset.usage.maxDepth === 1)).toBe(
      true,
    );
    expect(MODEL_ROUTING_PLANS.go.usage.maxSubagents).toBe(0);
    expect(MODEL_ROUTING_PLANS["plus-low"].root.reasoningEffort).toBe("medium");
    expect(MODEL_ROUTING_PLANS["plus-low"].usage.maxSubagents).toBe(1);
    expect(MODEL_ROUTING_PLANS.plus.usage.maxSubagents).toBe(2);
    expect(MODEL_ROUTING_PLANS["plus-high"].usage.maxSubagents).toBe(2);
    expect(MODEL_ROUTING_PLANS["pro-5x"].usage.maxSubagents).toBe(2);
    expect(MODEL_ROUTING_PLANS["pro-20x"].usage.maxSubagents).toBe(2);
    expect(
      Object.values(MODEL_ROUTING_PLANS).every((preset) =>
        [preset.root, ...Object.values(preset.agents)].every((route) =>
          ["low", "medium", "high"].includes(route.reasoningEffort),
        ),
      ),
    ).toBe(true);
    expect(
      new Set(Object.values(MODEL_ROUTING_PLANS["pro-20x"].agents).map((route) => route.model)),
    ).toEqual(new Set(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]));
  });

  it("documents the ordered routing ladder without quota claims", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme.indexOf("`go`")).toBeLessThan(readme.indexOf("`plus-low`"));
    expect(readme.indexOf("`plus-low`")).toBeLessThan(readme.indexOf("`plus`"));
    expect(readme.indexOf("`plus`")).toBeLessThan(readme.indexOf("`plus-high`"));
    expect(readme.indexOf("`plus-high`")).toBeLessThan(readme.indexOf("`pro-5x`"));
    expect(readme.indexOf("`pro-5x`")).toBeLessThan(readme.indexOf("`pro-20x`"));
    expect(readme).toContain("plan-selected direct subagent limit");
    expect(readme).not.toContain("subscription allowance");
  });

  it("rejects invalid plans, reasoning efforts, and incomplete routing presets", () => {
    expect(PlanNameSchema.safeParse("enterprise").success).toBe(false);
    expect(ReasoningEffortSchema.safeParse("max").success).toBe(false);
    expect(
      ModelRoutingPlansSchema.safeParse({
        ...MODEL_ROUTING_PLANS,
        plus: {
          ...MODEL_ROUTING_PLANS.plus,
          root: { ...MODEL_ROUTING_PLANS.plus.root, reasoningEffort: "max" },
        },
      }).success,
    ).toBe(false);
    expect(
      ModelRoutingPlansSchema.safeParse({
        ...MODEL_ROUTING_PLANS,
        plus: {
          ...MODEL_ROUTING_PLANS.plus,
          agents: {
            explorer: MODEL_ROUTING_PLANS.plus.agents.explorer,
            librarian: MODEL_ROUTING_PLANS.plus.agents.librarian,
          },
        },
      }).success,
    ).toBe(false);
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
      expect(prompt).not.toContain("I detect");
      expect(prompt).toContain(
        "Begin with requested evidence, status, results, uncertainty, or blockers.",
      );
      expect(prompt).toContain("before the first shell action");
      expect(prompt).toContain("callable and deferred tools");
      expect(prompt).toContain("Use it for every shell command");
      expect(prompt).toContain("If unavailable, stop and report the blocker");
      for (const rule of responseStyleContract) expect(prompt).toContain(rule);
      expect(prompt).toContain("Accept five packet concepts");
      for (const concept of specialistPacketConcepts) expect(prompt).toContain(concept);
      expect(prompt).toContain("Other context is optional and task-specific");
      expect(prompt).toContain("without irrelevant optional fields");
      expect(prompt).toContain("propose no extra work");
      expect(prompt).toContain("escalate automatically");
      expect(prompt).toContain("or delegate");
    }
    expect(await readFile(join(pluginRoot, "agents", "worker.toml"), "utf8")).toContain(
      "For prompt or instruction work, load caveman first.",
    );
  });

  it("keeps bundled agent routes aligned with the default routing plan", async () => {
    for (const agent of AGENTS) {
      const source = await readFile(join(pluginRoot, "agents", `${agent}.toml`), "utf8");
      const route = MODEL_ROUTING_PLANS[DEFAULT_PLAN].agents[agent];
      expect(rootTomlString(source, "model")).toBe(route.model);
      expect(rootTomlString(source, "model_reasoning_effort")).toBe(route.reasoningEffort);
    }
  });

  it("pins activation phrases and enables every MCP default", async () => {
    const expected = new Map([
      ["define-goal", "**GOAL MODE ACTIVATED**"],
      ["plan", "**PLAN MODE ACTIVATED**"],
      ["plan-review", "**PLAN REVIEW MODE ACTIVATED**"],
    ]);
    for (const [skill, phrase] of expected) {
      const text = await readFile(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(text).toContain(phrase);
      expect(text.split(phrase)).toHaveLength(2);
      expect(text).toContain("Only after this skill is fully loaded");
    }
    const headings = new Map<string, string>();
    for (const name of skills) {
      const text = await readFile(join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
      const heading = text.match(/^\*\*.* MODE ACTIVATED\*\*$/m)?.[0];
      if (heading !== undefined) headings.set(name, heading);
    }
    expect(headings).toEqual(expected);
    expect(await readFile(join(pluginRoot, "skills", "caveman", "SKILL.md"), "utf8")).toContain(
      "No activation heading or mode label.",
    );
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
    expect(description).toContain("capability-based routing");
    expect(description).toContain("Luna low");
    expect(description).toContain("Terra high");
    expect(description).toContain("mandatory only on native Windows");
    expect(description).toContain("decision, clarification, integration, and verification layer");
    expect(description).toContain("Prompt contracts guide routing");
    expect(description).toContain("not provider-side enforcement");
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
