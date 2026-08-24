// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import {
  LONG_CONTEXT_INPUT_THRESHOLD,
  costMaxToUnits,
  estimateRouteCost,
  pricingFor,
  settleUsage,
  type CostEstimate,
} from "./cost.ts";
import type { RouteDefinition } from "@holycodex/core";

const route = {
  key: "Worker:implementation",
  role: "Worker",
  task: "implementation",
  model: "Luna",
  effort: "high",
} satisfies RouteDefinition;

function estimate(contextTokens = 10, outputTokens = 10): CostEstimate {
  return estimateRouteCost({
    route,
    serviceTier: "Standard",
    maxContextTokens: contextTokens,
    maxOutputTokens: outputTokens,
  });
}

describe("measured token-equivalent pricing", () => {
  test("uses standard and priority rates for cached, uncached, output, and reasoning tokens", () => {
    const standard = settleUsage(
      {
        input_tokens: 1_000_000,
        cached_input_tokens: 250_000,
        output_tokens: 500_000,
        reasoning_output_tokens: 250_000,
      },
      estimate(),
    );
    const fast = settleUsage(
      {
        input_tokens: 1_000_000,
        cached_input_tokens: 250_000,
        output_tokens: 500_000,
        reasoning_output_tokens: 250_000,
      },
      { ...estimate(), pricingKey: "gpt-5.6-luna:priority:short" },
    );

    expect(standard.usageCompleteness).toBe("complete");
    expect(fast.costUnits).toBe(standard.costUnits * 2);
  });

  test("switches rates only above the long-context threshold", () => {
    expect(pricingFor("Luna", "Standard", LONG_CONTEXT_INPUT_THRESHOLD).contextClass).toBe("short");
    expect(pricingFor("Luna", "Standard", LONG_CONTEXT_INPUT_THRESHOLD + 1).contextClass).toBe(
      "long",
    );
  });

  test("rounds each exact integer component conservatively", () => {
    const result = settleUsage(
      {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 1,
      },
      estimate(),
    );
    expect(result.costUnits).toBe(1 + 1 + 2);
  });

  test("rejects unknown model pricing and exact decimal conversion stays integer", () => {
    expect(() => pricingFor("gpt-5.6-luna", "Standard", 1)).toThrow(
      /conservative pricing mapping/u,
    );
    expect(() => pricingFor("Luna", "Turbo", 1)).toThrow(/service tier/u);
    expect(costMaxToUnits(0.1)).toBe(100_000);
    expect(costMaxToUnits(0.0000001)).toBe(1);
  });

  test("settles below, equal to, and above the estimate", () => {
    const reservation = estimate(100, 100);
    const below = settleUsage(
      { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      reservation,
    );
    const equal = settleUsage(
      { input_tokens: 100, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 },
      reservation,
    );
    const above = settleUsage(
      {
        input_tokens: 10_000,
        cached_input_tokens: 0,
        output_tokens: 10_000,
        reasoning_output_tokens: 0,
      },
      reservation,
    );

    expect(below.costUnits).toBeLessThan(reservation.units);
    expect(equal.costUnits).toBe(reservation.units);
    expect(above.costUnits).toBeGreaterThan(reservation.units);
  });

  test("keeps missing and partial usage conservative instead of treating it as zero", () => {
    const reservation = estimate();
    expect(settleUsage(undefined, reservation)).toMatchObject({
      costUnits: reservation.units,
      usageCompleteness: "unknown",
    });
    expect(settleUsage({ input_tokens: 5 }, reservation)).toMatchObject({
      costUnits: reservation.units,
      usageCompleteness: "partial",
    });
    expect(() =>
      settleUsage(
        { input_tokens: -1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
        reservation,
      ),
    ).toThrow(/invalid token count/u);
  });
});
