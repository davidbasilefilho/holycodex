// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { invokeWorkflowCapability } from "./index.ts";

const outcome = {
  blocked: false,
  changed_files: [],
  confidence: 1,
  context_owner: null,
  material_findings: [],
  needs_more_context: false,
  needs_root_decision: false,
  needs_verification: false,
  relevant_files: [],
  remaining_risk: [],
  reuse_recommended: false,
  status: "completed",
  suggested_followup: null,
  suggested_luna_effort: null,
  suggested_specialist: null,
  verification: [],
  verification_passed: true,
} as const;

describe("workflow capability boundaries", () => {
  test("invokes an enabled host capability and preserves its JSON result", async () => {
    let received: unknown;
    const result = await invokeWorkflowCapability(
      "web",
      { objective: "lookup" },
      {
        capabilities: {
          web: {
            invoke: async (input) => {
              received = input;
              return outcome;
            },
          },
        },
      },
    );
    expect(received).toEqual({ objective: "lookup" });
    expect(result).toEqual(outcome);
  });

  test("denies unavailable capabilities and keeps Computer Use Root-only", async () => {
    await expect(invokeWorkflowCapability("security", {}, {})).rejects.toMatchObject({
      code: "capability_denied",
    });
    await expect(
      invokeWorkflowCapability(
        "computer_use",
        {},
        {
          rootAuthority: false,
          capabilities: { computer_use: { invoke: async () => ({ ok: true }) } },
        },
      ),
    ).rejects.toMatchObject({ code: "capability_denied" });
  });

  test("validates provider availability instead of inferring it from selection state", async () => {
    await expect(
      invokeWorkflowCapability(
        "lsp",
        { objective: "symbols" },
        { capabilities: { lsp: { available: async () => false, invoke: async () => outcome } } },
      ),
    ).rejects.toMatchObject({ code: "capability_denied", details: { available: false } });

    const result = await invokeWorkflowCapability(
      "git_bash",
      { objective: "path fixture" },
      {
        capabilities: {
          git_bash: {
            available: async () => true,
            invoke: async (input) => ({
              ...outcome,
              material_findings: [String(input["objective"])],
            }),
          },
        },
      },
    );
    expect(result).toMatchObject({ material_findings: ["path fixture"] });
  });
});
