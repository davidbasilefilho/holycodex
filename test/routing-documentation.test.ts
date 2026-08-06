import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MODEL_ROUTING_PLANS, PLAN_NAMES } from "../packages/cli/src/catalog";

const root = join(import.meta.dirname, "..");

describe("dynamic workflow documentation", () => {
  it("documents model-authored control flow and the absence of fixed routes", async () => {
    const document = await readFile(join(root, "docs", "ROUTING.md"), "utf8");
    expect(document).toContain("model-authored dynamic workflows");
    expect(document).toContain("top-level `await`");
    expect(document).toContain("`agent()`");
    expect(document).toContain("`pipeline()`");
    expect(document).toContain("name each specialist type and what it will do");
    expect(document).toContain("creates independent threads");
    expect(document).toContain("specialist agents run through workflows unless");
    expect(document).not.toContain("regular visible Codex subagents");
    expect(document).toContain("do not imply a fixed Explorer to Librarian to Worker sequence");
    expect(document).not.toContain("two lanes per wave");
  });

  it("documents plan quotas, unbounded runtime, and Fast as a service-tier-only choice", async () => {
    const document = await readFile(join(root, "docs", "ROUTING.md"), "utf8");
    expect(document).toContain("Workflows have no wall-clock deadline");
    expect(document).toContain("Fast is only a latency-oriented opt-in");
    expect(document).toContain("Neither flag changes model selection or reasoning effort");
  });

  it("keeps Fast projections independent from model and effort", () => {
    for (const plan of PLAN_NAMES) {
      const preset = MODEL_ROUTING_PLANS[plan];
      expect(preset.workflow.projectedUsage.fast).toEqual({
        minimum: preset.workflow.projectedUsage.standard.minimum * 2,
        maximum: preset.workflow.projectedUsage.standard.maximum * 2,
      });
      expect(preset.workflow.serviceTiers).toEqual(["default", "fast"]);
    }
  });

  it("documents target calls separately from hard maximum calls", async () => {
    const document = await readFile(join(root, "docs", "ROUTING.md"), "utf8");
    expect(document).toContain("soft target calls");
    expect(document).toContain("hard maximum calls");
    expect(document).toContain("`plus-low` is the default");
    expect(document).toContain("native subagents are fallback-only");
  });
});
