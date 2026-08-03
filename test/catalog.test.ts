import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_MODELS,
  AGENTS,
  DEFAULT_PLAN,
  effectiveMcpServers,
  GENERATED_RUNTIMES,
  MANAGED_AGENT_MODEL_HISTORY_BY_PLAN,
  MANAGED_ROOT_MODEL_HISTORY_BY_PLAN,
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
const generatedRuntimeAvailable = await access(
  join(pluginRoot, "runtime", "core-instructions.js"),
).then(
  () => true,
  () => false,
);
const skills = SKILLS;

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

  it("defines the exact ordered six-tier routing plan", () => {
    expect(PLAN_NAMES).toEqual(["go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"]);
    expect(Object.keys(MODEL_ROUTING_PLANS)).toEqual(PLAN_NAMES);
    expect(DEFAULT_PLAN).toBe("plus");
    expect(MODEL_ROUTING_PLANS).toEqual({
      go: {
        root: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        },
        usage: { maxSubagents: 0, maxDepth: 1 },
      },
      "plus-low": {
        root: { model: "gpt-5.6-sol", reasoningEffort: "low" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
      plus: {
        root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
      "plus-high": {
        root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
      "pro-5x": {
        root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
      "pro-20x": {
        root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "max" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
    });
    expect(JSON.stringify(MODEL_ROUTING_PLANS)).toContain('"max"');
  });

  it("uses Luna for active agents and excludes Terra", () => {
    for (const plan of PLAN_NAMES)
      for (const agent of AGENTS)
        expect(MODEL_ROUTING_PLANS[plan].agents[agent].model).not.toBe("gpt-5.6-sol");
    expect(JSON.stringify(MODEL_ROUTING_PLANS)).not.toContain("gpt-5.6-terra");
  });

  it("recognizes every outgoing managed route without duplicate plan history", () => {
    const outgoingAgents = {
      go: {
        worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      },
      plus: {
        worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      },
      "plus-high": {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        worker: { model: "gpt-5.6-luna", reasoningEffort: "max" },
      },
      "pro-5x": {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        worker: { model: "gpt-5.6-luna", reasoningEffort: "max" },
      },
      "pro-20x": {
        explorer: { model: "gpt-5.6-luna", reasoningEffort: "max" },
        librarian: { model: "gpt-5.6-luna", reasoningEffort: "max" },
      },
    } as const;

    for (const [plan, agents] of Object.entries(outgoingAgents))
      for (const [agent, route] of Object.entries(agents))
        expect(
          MANAGED_AGENT_MODEL_HISTORY_BY_PLAN[plan as keyof typeof outgoingAgents][
            agent as keyof typeof agents
          ],
        ).toContainEqual(route);
    expect(MANAGED_ROOT_MODEL_HISTORY_BY_PLAN.go).toContainEqual({
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
    });

    for (const plan of PLAN_NAMES) {
      expect(
        new Set(MANAGED_ROOT_MODEL_HISTORY_BY_PLAN[plan].map((route) => JSON.stringify(route)))
          .size,
      ).toBe(MANAGED_ROOT_MODEL_HISTORY_BY_PLAN[plan].length);
      for (const agent of AGENTS) {
        const routes = MANAGED_AGENT_MODEL_HISTORY_BY_PLAN[plan][agent];
        expect(new Set(routes.map((route) => JSON.stringify(route))).size).toBe(routes.length);
      }
    }
  });

  it("documents the ordered routing ladder without quota claims", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const routing = await readFile(join(root, "docs", "ROUTING.md"), "utf8");
    expect(readme.indexOf("`go`")).toBeLessThan(readme.indexOf("`plus-low`"));
    expect(readme.indexOf("`plus-low`")).toBeLessThan(readme.indexOf("`plus`"));
    expect(readme.indexOf("`plus`")).toBeLessThan(readme.indexOf("`plus-high`"));
    expect(readme.indexOf("`plus-high`")).toBeLessThan(readme.indexOf("`pro-5x`"));
    expect(readme.indexOf("`pro-5x`")).toBeLessThan(readme.indexOf("`pro-20x`"));
    expect(readme).toContain("plan-selected direct subagent limit");
    expect(readme).not.toContain("subscription allowance");
    const labels = {
      "gpt-5.6-luna": "Luna",
      "gpt-5.6-terra": "Terra",
      "gpt-5.6-sol": "Sol",
    } as const;
    const normalizedReadme = readme.replace(/\s+/g, " ");
    const normalizedRouting = routing.replace(/\s+/g, " ");
    for (const plan of PLAN_NAMES) {
      const preset = MODEL_ROUTING_PLANS[plan];
      const route = (value: typeof preset.root): string =>
        `${labels[value.model]} ${value.reasoningEffort}`;
      const values = [
        route(preset.root),
        route(preset.agents.explorer),
        route(preset.agents.librarian),
        route(preset.agents.worker),
      ];
      expect(normalizedReadme).toContain(
        `| \`${plan}\` ${values.map((value) => `| GPT-5.6 ${value} `).join("")}|`,
      );
      expect(normalizedRouting).toContain(
        `| \`${plan}\` ${values.map((value) => `| ${value} `).join("")}| ${preset.usage.maxSubagents} |`,
      );
    }
  });

  it("rejects invalid plans, reasoning efforts, and incomplete routing presets", () => {
    expect(PlanNameSchema.safeParse("enterprise").success).toBe(false);
    expect(ReasoningEffortSchema.safeParse("max").success).toBe(true);
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

  it("accepts any nonnegative subagent limit and rejects invalid limits", () => {
    const withMaxSubagents = (maxSubagents: number) => ({
      ...MODEL_ROUTING_PLANS,
      plus: {
        ...MODEL_ROUTING_PLANS.plus,
        usage: { ...MODEL_ROUTING_PLANS.plus.usage, maxSubagents },
      },
    });

    expect(ModelRoutingPlansSchema.safeParse(withMaxSubagents(0)).success).toBe(true);
    expect(ModelRoutingPlansSchema.safeParse(withMaxSubagents(3)).success).toBe(true);
    expect(ModelRoutingPlansSchema.safeParse(withMaxSubagents(-1)).success).toBe(false);
    expect(ModelRoutingPlansSchema.safeParse(withMaxSubagents(1.5)).success).toBe(false);
  });

  it("uses the HolyCodex marketplace label", async () => {
    const marketplace = JSON.parse(await readFile(join(root, "marketplace.json"), "utf8")) as {
      name: string;
      interface?: { displayName?: string };
    };
    expect(marketplace.name).toBe("HolyCodex");
    expect(marketplace.interface?.displayName).toBe("HolyCodex");
    const plugin = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { name: string; interface?: { displayName?: string } };
    expect(plugin.name).toBe("holycodex");
    expect(plugin.interface?.displayName).toBe("HolyCodex");
  });

  it("ships only routed skills and three described agents", async () => {
    expect((await readdir(join(pluginRoot, "skills"))).sort()).toEqual([...skills].sort());
    for (const skill of skills) {
      const text = await readFile(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(text).toMatch(/^description: Use (?:when|for) /m);
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
      expect(prompt).toMatch(/^description = ".+"$/m);
      expect(prompt).not.toContain("I detect");
      expect(prompt).toMatch(/Lead with requested .*result/);
      expect(prompt).toContain("On native Windows");
      expect(prompt).toContain("mcp__git_bash__run");
      expect(prompt).toContain("all Git, Bash, POSIX, package, build, test, script commands");
      expect(prompt).toContain("If absent, stop");
      expect(prompt).toContain(
        "Packets contain outcome/question, scope, fixed decisions, proof, stops/blockers",
      );
      expect(prompt).toContain("other context is optional");
      expect(prompt).toContain("auto-escalate");
      expect(prompt).toContain("delegate");
    }
    expect(await readFile(join(pluginRoot, "agents", "worker.toml"), "utf8")).toContain(
      "Prompt/instruction work loads `caveman`",
    );
  });

  it("keeps bundled agent routes aligned with the default routing plan", async () => {
    for (const agent of AGENTS) {
      const source = await readFile(join(pluginRoot, "agents", `${agent}.toml`), "utf8");
      const route = MODEL_ROUTING_PLANS[DEFAULT_PLAN].agents[agent];
      expect(rootTomlString(source, "model")).toBe(route.model);
      expect(rootTomlString(source, "model_reasoning_effort")).toBe(route.reasoningEffort);
      expect(rootTomlString(source, "service_tier")).toBe("default");
    }
  });

  it("pins activation phrases and enables every MCP default", async () => {
    const expected = new Map([
      ["plan", "**PLAN MODE ACTIVATED**"],
      ["plan-review", "**PLAN REVIEW MODE ACTIVATED**"],
    ]);
    for (const [skill, phrase] of expected) {
      const text = await readFile(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(text).toContain(phrase);
      expect(text.split(phrase)).toHaveLength(2);
      expect(text).toMatch(/(?:Only )?after full load, first (?:user-)?visible lines/i);
    }
    const headings = new Map<string, string>();
    for (const name of skills) {
      const text = await readFile(join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
      const heading = text.match(/^\*\*.* MODE ACTIVATED\*\*$/m)?.[0];
      if (heading !== undefined) headings.set(name, heading);
    }
    expect(headings).toEqual(expected);
    expect(await readFile(join(pluginRoot, "skills", "caveman", "SKILL.md"), "utf8")).toContain(
      "No activation heading/label.",
    );
    const plugin = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { mcpServers?: unknown };
    expect(plugin.mcpServers).toBe("./.mcp.json");

    const manifest = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(manifest.mcpServers).toEqual(effectiveMcpServers("win32"));
  });

  it.runIf(generatedRuntimeAvailable)("ships the complete generated runtime", async () => {
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
    expect(description).toContain("Sol is reserved for Root");
    expect(description).toContain("active specialists use Luna");
    expect(description).not.toContain("active specialists use Luna or Terra");
    expect(description).toContain("mandatory only on native Windows");
    expect(description).toContain("decision, clarification, integration, and verification layer");
    expect(description).toContain("Prompt contracts guide routing");
    expect(description).toContain("not provider-side enforcement");
  });

  it("gives every local MCP tool invocation guidance", async () => {
    for (const tool of LSP_MCP_TOOLS) expect(tool.description).toMatch(/^[A-Z].+\.$/);
    const response = await handleGitBashMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { platform: "linux", env: {}, exists: () => false, where: () => [] },
    );
    if (response === undefined || "error" in response || response.result === undefined)
      throw new Error("tools/list failed");
    const tools = response.result.tools as Array<{ description: string }>;
    for (const tool of tools) expect(tool.description).toMatch(/^[A-Z].+\.$/);
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
