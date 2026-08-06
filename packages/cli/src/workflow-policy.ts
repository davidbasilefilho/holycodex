import type { PlanName } from "./catalog.ts";

/** Rejects workflow execution for plans without workflow capacity. */
export function assertWorkflowAvailable(plan: PlanName): void {
  if (plan === "go")
    throw new Error(
      "Dynamic workflows are unavailable on the go plan. Root must work directly without specialist subagents.",
    );
}
