import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENTS,
  DEFAULT_PLAN,
  MODEL_ROUTING_PLANS,
  PLAN_NAMES,
  type FastMode,
} from "../packages/cli/src/catalog";
import { installConfig, readManagedFastMode } from "../packages/cli/src/config";
import { cleanup, install, type InstallRuntime } from "../packages/cli/src/install";
import { renderHelp, renderInstallHelp } from "../packages/cli/src/presentation";
import { rootTomlString } from "../packages/cli/src/toml";

const originalHome = process.env.CODEX_HOME;
const runtime: InstallRuntime = {
  platform: "linux",
  gitBash: () => ({ found: false, checkedPaths: [], installHint: "unused" }),
  runProcess: async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      installed: [{ pluginId: "codex-security@openai-curated", installed: true, enabled: true }],
      available: [],
    }),
    stderr: "",
    timedOut: false,
    matched: false,
    outputTruncated: false,
  }),
};

function rootTomlAssignmentCount(input: string, key: string): number {
  const root = input.split(/^\s*\[/m, 1)[0] ?? "";
  return root.match(new RegExp(`^${key}\\s*=`, "gm"))?.length ?? 0;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
});

describe("routing and Fast mode seams", () => {
  it("defines plan-authoritative dynamic workflow policies", () => {
    expect(PLAN_NAMES).toEqual(["go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"]);
    expect(DEFAULT_PLAN).toBe("plus");
    for (const plan of PLAN_NAMES) {
      const workflow = MODEL_ROUTING_PLANS[plan].workflow;
      expect(workflow.limits.totalCalls).toBeGreaterThan(0);
      expect(workflow.limits.workflowDepth).toBeGreaterThan(1);
      expect(workflow.limits.retries).toBeGreaterThanOrEqual(0);
      expect(workflow.limits.loopIterations).toBeGreaterThan(0);
      expect(workflow.limits.fanOut).toBeGreaterThan(0);
      expect(workflow.projectedUsage.fast).toBe(workflow.projectedUsage.standard * 2);
      expect(workflow.runtime.maxSeconds).toBeGreaterThan(0);
      expect(workflow.softSizeGuidance.maxInputTokens).toBeGreaterThan(0);
      for (const agent of AGENTS) {
        expect(Object.keys(workflow.permittedRoutes[agent])).toEqual([
          "analysis",
          "research",
          "implementation",
          "verification",
        ]);
        for (const routes of Object.values(workflow.permittedRoutes[agent]))
          for (const route of routes) expect(route.reasoningEffort).toBeDefined();
      }
    }
    expect(JSON.stringify(MODEL_ROUTING_PLANS)).not.toContain("maxDepth");
    expect(JSON.stringify(MODEL_ROUTING_PLANS)).not.toContain("maxSubagents");
  });

  it.each([
    ["standard", "default", "default"],
    ["fast", "default", "fast"],
    ["fast-all", "fast", "fast"],
  ] as const)("maps %s to root and agent service tiers", async (mode, rootTier, agentTier) => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-fast-mode-"));
    process.env.CODEX_HOME = home;
    await install({ autonomy: "default", json: false, fast: mode as FastMode }, runtime);
    const config = await readFile(join(home, "config.toml"), "utf8");
    expect(rootTomlString(config, "service_tier")).toBe(rootTier);
    expect(rootTomlString(config, "model")).toBe(MODEL_ROUTING_PLANS.plus.root.model);
    expect(rootTomlString(config, "model_reasoning_effort")).toBe(
      MODEL_ROUTING_PLANS.plus.root.reasoningEffort,
    );
    expect(readManagedFastMode(config)).toBe(mode);
    for (const agent of AGENTS) {
      const source = await readFile(join(home, "holycodex", "agents", `${agent}.toml`), "utf8");
      expect(rootTomlString(source, "service_tier")).toBe(agentTier);
      expect(rootTomlString(source, "model")).toBe(MODEL_ROUTING_PLANS.plus.agents[agent].model);
      expect(rootTomlString(source, "model_reasoning_effort")).toBe(
        MODEL_ROUTING_PLANS.plus.agents[agent].reasoningEffort,
      );
      expect(rootTomlAssignmentCount(source, "service_tier")).toBe(1);
    }
  });

  it("migrates stale global-fast state while preserving user-owned agent settings", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-fast-upgrade-"));
    process.env.CODEX_HOME = home;
    await install({ autonomy: "default", json: false, fast: "fast-all" }, runtime);
    const explorerPath = join(home, "holycodex", "agents", "explorer.toml");
    await writeFile(
      explorerPath,
      `${await readFile(explorerPath, "utf8")}temperature = 0.2\n[custom]\nkeep = true\n`,
    );
    await install({ autonomy: "default", json: false, fast: "standard" }, runtime);
    expect(rootTomlString(await readFile(join(home, "config.toml"), "utf8"), "service_tier")).toBe(
      "default",
    );
    for (const agent of AGENTS) {
      const source = await readFile(join(home, "holycodex", "agents", `${agent}.toml`), "utf8");
      expect(rootTomlAssignmentCount(source, "service_tier")).toBe(1);
    }
    const explorer = await readFile(explorerPath, "utf8");
    expect(rootTomlString(explorer, "service_tier")).toBe("default");
    expect(explorer).toContain("temperature = 0.2");
    expect(explorer).toContain("[custom]\nkeep = true");
    await cleanup({ autonomy: "default", json: false });
    await expect(readFile(explorerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("documents all Fast modes in general and install help", () => {
    expect(renderHelp("test", false)).toContain("--fast-all");
    expect(renderInstallHelp("test", false)).toContain("--fast-all");
  });

  it("applies the standard root tier when no Fast option is supplied", () => {
    const output = installConfig("", "default", "linux", DEFAULT_PLAN);
    expect(rootTomlString(output, "service_tier")).toBe("default");
    expect(readManagedFastMode(output)).toBe("standard");
  });
});
