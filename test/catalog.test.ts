import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENTS,
  DEFAULT_PLAN,
  GENERATED_RUNTIMES,
  MODEL_ROUTING_PLANS,
  PLAN_NAMES,
  requiredPackageRuntimes,
  SKILLS,
  VERSION,
} from "../packages/cli/src/catalog";
import { LSP_COMMANDS } from "../packages/lsp-core/src/tools";

const root = join(import.meta.dirname, "..");
const plugin = join(root, "packages", "plugin", "plugin");

describe("authoritative catalog", () => {
  it("keeps version, plans, routes, limits, skills, and runtimes typed in one source", () => {
    expect(DEFAULT_PLAN).toBe("plus");
    expect(Object.keys(MODEL_ROUTING_PLANS)).toEqual(PLAN_NAMES);
    for (const plan of PLAN_NAMES) {
      expect(MODEL_ROUTING_PLANS[plan].workflow.limits.workflowDepth).toBeGreaterThan(1);
      expect(MODEL_ROUTING_PLANS[plan].workflow.limits.totalCalls).toBeGreaterThan(0);
      expect(MODEL_ROUTING_PLANS[plan].workflow.verbosity).toBe("low");
      expect(MODEL_ROUTING_PLANS[plan].workflow.serviceTiers).toEqual(["default", "fast"]);
      expect(Object.keys(MODEL_ROUTING_PLANS[plan].agents)).toEqual(AGENTS);
    }
    expect(SKILLS).toContain("context7-cli");
    expect(SKILLS).not.toContain("caveman");
    expect(GENERATED_RUNTIMES).not.toContain("mcp-stdio-core.js");
    expect(LSP_COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining([
        "status",
        "diagnostics",
        "goto_definition",
        "goto_declaration",
        "find_references",
        "symbols",
        "prepare_rename",
        "rename",
      ]),
    );
  });

  it("ships zero MCP manifests or MCP runtime requirements", async () => {
    await expect(access(join(plugin, ".mcp.json"))).rejects.toBeDefined();
    expect(requiredPackageRuntimes("win32").join(" ")).not.toMatch(/mcp/i);
    const manifest = await readFile(join(plugin, ".codex-plugin", "plugin.json"), "utf8");
    expect(manifest).not.toMatch(/mcpServers|MCP Tools/);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
