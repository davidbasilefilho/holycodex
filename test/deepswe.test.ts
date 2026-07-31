import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const terraMedium = { passPercent: 35.1, totalCost: 0.467, steps: 25.1 };

function deriveMetrics(input: { passPercent: number; totalCost: number; steps: number }) {
  const passFraction = input.passPercent / 100;
  const terraPassFraction = terraMedium.passPercent / 100;
  const costPerSuccess = input.totalCost / passFraction;
  const terraCostPerSuccess = terraMedium.totalCost / terraPassFraction;
  return {
    passFraction,
    totalCost: input.totalCost,
    costPerSuccess,
    stepsPerSuccess: input.steps / passFraction,
    relativeCost: input.totalCost / terraMedium.totalCost,
    relativeCostPerSuccess: costPerSuccess / terraCostPerSuccess,
  };
}

describe("DeepSWE v1.1 calculations", () => {
  it("converts percentages and derives cost and steps per success", () => {
    const lunaHigh = deriveMetrics({ passPercent: 44.2, totalCost: 0.156, steps: 49 });
    expect(lunaHigh.passFraction).toBe(0.442);
    expect(lunaHigh.costPerSuccess).toBeCloseTo(0.35294, 5);
    expect(lunaHigh.stepsPerSuccess).toBeCloseTo(111, 0);
  });

  it("normalizes cost and cost per success to Terra medium", () => {
    const baseline = deriveMetrics(terraMedium);
    expect(baseline.relativeCost).toBe(1);
    expect(baseline.relativeCostPerSuccess).toBe(1);

    const lunaHigh = deriveMetrics({ passPercent: 44.2, totalCost: 0.156, steps: 49 });
    expect(lunaHigh.relativeCost).toBeCloseTo(0.33, 2);
    expect(lunaHigh.relativeCostPerSuccess).toBeCloseTo(0.265, 3);
  });

  it("applies the fixed Fast multiplier without changing quality or steps", () => {
    const standard = { passPercent: 44.2, totalCost: 0.1556, steps: 49 };
    const fast = { ...standard, totalCost: standard.totalCost * 2.5 };
    expect(fast.totalCost).toBeCloseTo(0.389, 3);
    expect(fast.passPercent).toBe(standard.passPercent);
    expect(fast.steps).toBe(standard.steps);
  });

  it("uses supplied total cost directly and documents both double-counting guards", async () => {
    const input = { passPercent: 44.2, totalCost: 0.156, steps: 49 };
    expect(deriveMetrics(input).totalCost).toBe(input.totalCost);
    expect(deriveMetrics(input).totalCost).not.toBe(input.totalCost * input.steps);

    const document = await readFile(join(root, "docs", "deepswe-v1.1.md"), "utf8");
    expect(document).toContain("must not be repriced again");
    expect(document).toContain("would double-count usage");
    expect(document).not.toContain("repriced_cost = original_deepswe_cost");
  });
});
