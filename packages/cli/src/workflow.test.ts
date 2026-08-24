// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { SPECIALIST_OUTCOME_VERSION } from "@holycodex/core";
import { invokeWorkflowCapability, loadNativeWorkflow } from "./index.ts";

function capabilityResult(
  capability: "web" | "lsp" | "git_bash",
  data: Record<string, unknown> = {},
) {
  return {
    protocol_version: SPECIALIST_OUTCOME_VERSION,
    capability,
    route: { role: "Worker", task: "implementation" },
    evidence: [],
    data,
    status: "completed",
    summary: `${capability} completed`,
  } as const;
}

describe("workflow capability boundaries", () => {
  test("invokes an enabled host capability and preserves its JSON result", async () => {
    let received: unknown;
    const output = await invokeWorkflowCapability(
      "web",
      { objective: "lookup" },
      {
        capabilities: {
          web: {
            invoke: async (input) => {
              received = input;
              return capabilityResult("web");
            },
          },
        },
      },
    );
    expect(received).toMatchObject({
      capability: "web",
      objective: "lookup",
      route: "Worker:implementation",
      role_task: { role: "Worker", task: "implementation" },
    });
    expect(output).toEqual(capabilityResult("web"));
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
          capabilities: {
            computer_use: {
              invoke: async () => ({
                protocol_version: SPECIALIST_OUTCOME_VERSION,
                capability: "computer_use",
                route: null,
                evidence: ["root adapter"],
                data: { ok: true },
                status: "completed",
                summary: "root operation completed",
              }),
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "capability_denied" });
    const rootResult = await invokeWorkflowCapability(
      "computer_use",
      { objective: "approved root action" },
      {
        rootAuthority: true,
        capabilities: {
          computer_use: {
            invoke: async () => ({
              protocol_version: SPECIALIST_OUTCOME_VERSION,
              capability: "computer_use",
              route: null,
              evidence: ["root adapter"],
              data: { ok: true },
              status: "completed",
              summary: "root operation completed",
            }),
          },
        },
      },
    );
    expect(rootResult).toMatchObject({ capability: "computer_use", route: null });
  });

  test("validates provider availability instead of inferring it from selection state", async () => {
    await expect(
      invokeWorkflowCapability(
        "lsp",
        { objective: "symbols" },
        {
          capabilities: {
            lsp: { available: async () => false, invoke: async () => capabilityResult("lsp") },
          },
        },
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
              ...capabilityResult("git_bash", { objective: input.objective }),
            }),
          },
        },
      },
    );
    expect(result).toMatchObject({ data: { objective: "path fixture" } });
  });

  test("rejects capability output tampering at the common V2 boundary", async () => {
    await expect(
      invokeWorkflowCapability(
        "web",
        {},
        {
          capabilities: {
            web: { invoke: async () => capabilityResult("lsp") },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "capability_denied",
      details: { reason: "invalid_provider_outcome" },
    });

    await expect(
      invokeWorkflowCapability(
        "web",
        {},
        {
          capabilities: {
            web: {
              invoke: async () => ({
                ...capabilityResult("web"),
                route: { role: "Reviewer", task: "code" },
              }),
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "capability_denied",
      details: { reason: "provider_route_tamper" },
    });
  });
});

describe("native workflow loader", () => {
  test("loads trusted TypeScript as bounded native data without module import", async () => {
    const native = await loadNativeWorkflow({
      source: `
        import { createCodec, workflow } from "@holycodex/workflow-runtime";
        const text = createCodec("text", (value: unknown): string => String(value));
        const step = workflow.step({ id: "loader-step", assignment: { input: text, output: text } });
        export default workflow.wait(step);
      `,
      args: {},
      path: "C:/trusted/workflow.ts",
    });
    try {
      expect(native.ir.executionMode).toBe("native");
      expect(native.ir.graph.nodes.map((node) => node.id)).toEqual(["loader-step"]);
    } finally {
      native.dispose();
    }
  });
});
