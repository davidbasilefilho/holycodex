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
};

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
});

describe("routing and Fast mode seams", () => {
  it("defines the six fixed routes with depth one and no active Sol agents", () => {
    expect(PLAN_NAMES).toEqual(["go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"]);
    expect(DEFAULT_PLAN).toBe("plus");
    expect(MODEL_ROUTING_PLANS).toEqual({
      go: {
        root: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
        agents: {
          explorer: { model: "gpt-5.6-terra", reasoningEffort: "low" },
          librarian: { model: "gpt-5.6-terra", reasoningEffort: "low" },
          worker: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
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
        usage: { maxSubagents: 1, maxDepth: 1 },
      },
      plus: {
        root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "high" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
      "plus-high": {
        root: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
      "pro-5x": {
        root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
      "pro-20x": {
        root: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        agents: {
          explorer: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
          librarian: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
          worker: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        },
        usage: { maxSubagents: 2, maxDepth: 1 },
      },
    });
    for (const plan of PLAN_NAMES) {
      expect(MODEL_ROUTING_PLANS[plan].usage.maxDepth).toBe(1);
      for (const agent of AGENTS)
        expect(MODEL_ROUTING_PLANS[plan].agents[agent].model).not.toBe("gpt-5.6-sol");
    }
    expect(JSON.stringify(MODEL_ROUTING_PLANS)).not.toContain('"max"');
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
    expect(readManagedFastMode(config)).toBe(mode);
    for (const agent of AGENTS) {
      const source = await readFile(join(home, "holycodex", "agents", `${agent}.toml`), "utf8");
      expect(rootTomlString(source, "service_tier")).toBe(agentTier);
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
