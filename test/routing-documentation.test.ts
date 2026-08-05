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
    expect(document).toContain("do not imply a fixed Explorer to Librarian to Worker sequence");
    expect(document).not.toContain("two lanes per wave");
  });

  it("documents hard plan quotas and Fast as a service-tier-only choice", async () => {
    const document = await readFile(join(root, "docs", "ROUTING.md"), "utf8");
    expect(document).toContain("Hard runtime limits cannot be changed or bypassed");
    expect(document).toContain("Fast is only a service-tier choice");
    expect(document).toContain("Neither flag changes model selection or reasoning effort");
  });

  it("keeps Fast projections independent from model and effort", () => {
    for (const plan of PLAN_NAMES) {
      const preset = MODEL_ROUTING_PLANS[plan];
      expect(preset.workflow.projectedUsage.fast).toBe(preset.workflow.projectedUsage.standard * 2);
      expect(preset.workflow.serviceTiers).toEqual(["default", "fast"]);
    }
  });
});
