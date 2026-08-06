import { describe, expect, it } from "vitest";

import { assertWorkflowAvailable } from "../packages/cli/src/workflow-policy.ts";

describe("workflow plan policy", () => {
  it("rejects workflows on go and requires direct Root work", () => {
    expect(() => assertWorkflowAvailable("go")).toThrow(
      "Dynamic workflows are unavailable on the go plan. Root must work directly without specialist subagents.",
    );
  });

  it.each(["plus-low", "plus", "plus-high", "pro-5x", "pro-20x"] as const)(
    "allows workflows on %s",
    (plan) => {
      expect(() => assertWorkflowAvailable(plan)).not.toThrow();
    },
  );
});
