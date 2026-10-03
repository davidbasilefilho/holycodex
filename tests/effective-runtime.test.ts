// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";

import { Effect } from "effect";

import { parseConfig } from "../packages/cli/src/installer.ts";
import { renderGenericBuiltinSentinel } from "../packages/cli/src/native-agents.ts";
import { readTomlPath } from "../packages/codex/src/runtime-config.ts";
import { GENERIC_BUILTIN_AGENT_TYPES } from "../packages/core/src/routes.ts";
import {
  collectEffectiveRuntimeEvidence,
  matchGenericBuiltinSentinel,
  persistEffectiveRuntimeFailure,
  type EffectiveRuntimeEvidence,
  type RouteProbe,
} from "../scripts/effective-runtime-proof.ts";

for (const agentType of GENERIC_BUILTIN_AGENT_TYPES) {
  test(`mock response recognizes only the canonical ${agentType} sentinel`, () => {
    const canonical = renderGenericBuiltinSentinel(agentType);
    expect(matchGenericBuiltinSentinel(canonical)).toBe(agentType);
    const wrongRole = GENERIC_BUILTIN_AGENT_TYPES.find((candidate) => candidate !== agentType);
    expect(wrongRole).toBeDefined();
    if (wrongRole !== undefined)
      expect(matchGenericBuiltinSentinel(renderGenericBuiltinSentinel(wrongRole))).not.toBe(
        agentType,
      );
    if (wrongRole !== undefined)
      expect(
        matchGenericBuiltinSentinel(`${canonical}\n${renderGenericBuiltinSentinel(wrongRole)}`),
      ).toBe(undefined);
  });
}

test("installed Codex executes the managed concrete V1 leaf route", async () => {
  await verifyEvidence("concrete", (concrete) => {
    assertRootContract(concrete);
    const concreteCalls = calls(concrete, "spawn_agent");
    expect(concreteCalls).toHaveLength(1);
    const concreteArgs = argumentsOf(concreteCalls[0]);
    expect(concreteArgs["agent_type"]).toBe("Worker.validation");
    expect(concreteArgs["fork_context"]).toBe(false);
    expect(concreteArgs).not.toHaveProperty("model");
    expect(concreteArgs).not.toHaveProperty("reasoning_effort");
    expect(calls(concrete, "wait_agent")).toHaveLength(1);
    expect(calls(concrete, "close_agent")).toHaveLength(1);
    expectWaitContract(concrete);
    expectLifecycleClosed(concrete);

    const worker = concrete.specialistRequests[0];
    expect(worker?.["model"]).toBe("gpt-6-luna");
    expect(worker).toBeDefined();
    if (worker === undefined) throw new Error("The V1 handler did not invoke Worker.validation.");
    expectRenderedSections(worker, concrete.specialistBaseInstructions, [
      ["# Specialist authority\n", "# Autonomy and persistence\n"],
      ["# Working with Root\n", "# Rules for getting work done\n"],
    ]);
    expect(developerInstructions(worker)).toContain(
      "Independently exercise the assigned local behavior",
    );
    expectActualProjectedAgentInstructions(concrete, worker, "Worker.validation");
    expectLeafTools(worker);
    expect(developerInstructions(worker)).not.toContain(
      "Root owns user interaction. Send an intermediate update only when it changes a Root decision",
    );
    expect(developerInstructions(worker)).not.toContain(
      "Root delegates all delegable execution and discovery through bounded Assignments; Root owns",
    );
    expect(concrete.projectedAgentConfigs["Worker.validation"]).toContain(
      `personality = "${concrete.expectedChildPersonality}"`,
    );
  });
}, 180_000);

test("installed Codex fails closed for an omitted route or uses its configured sentinel", async () => {
  await verifyEvidence("omitted", (omitted) => {
    assertRootContract(omitted);
    const omittedCalls = calls(omitted, "spawn_agent");
    expect(omittedCalls).toHaveLength(1);
    const omittedArgs = argumentsOf(omittedCalls[0]);
    expect(omittedArgs).not.toHaveProperty("agent_type");
    expect(omittedArgs["fork_context"]).toBe(false);
    expect(calls(omitted, "wait_agent")).toHaveLength(1);
    expectWaitContract(omitted);
    expectGenericRouteBehavior(omitted, "default");
  });
}, 180_000);

test("installed Codex rejects an invalid route without launching a child", async () => {
  await verifyEvidence("invalid", (invalid) => {
    assertRootContract(invalid);
    const invalidCalls = calls(invalid, "spawn_agent");
    expect(invalidCalls).toHaveLength(1);
    const invalidArgs = argumentsOf(invalidCalls[0]);
    expect(invalidArgs["agent_type"]).toBe("unregistered-route");
    expect(invalidArgs["fork_context"]).toBe(false);
    const invalidResult = invalid.rootToolResults.find(
      (result) => result["call_id"] === "root-spawn",
    );
    expect(invalidResult).toBeDefined();
    const invalidOutput = JSON.stringify(invalidResult?.["output"] ?? "");
    expect(invalidOutput).toMatch(/unknown agent_type/u);
    expect(invalidOutput).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
    );
    expect(invalid.specialistRequests).toHaveLength(0);
    expect(calls(invalid, "wait_agent")).toHaveLength(0);
    expect(calls(invalid, "close_agent")).toHaveLength(0);
  });
}, 180_000);

for (const agentType of GENERIC_BUILTIN_AGENT_TYPES) {
  test(`installed Codex shadows explicit generic ${agentType} routes with the fail-closed sentinel`, async () => {
    await verifyEvidence(`generic-${agentType}`, (evidence) => {
      assertRootContract(evidence);
      expect(argumentsOf(calls(evidence, "spawn_agent")[0])["agent_type"]).toBe(agentType);
      expectGenericRouteBehavior(evidence, agentType);
    });
  }, 180_000);
}

async function verifyEvidence(
  route: RouteProbe,
  verify: (evidence: EffectiveRuntimeEvidence) => void,
): Promise<void> {
  const evidence = await Effect.runPromise(collectEffectiveRuntimeEvidence(route, "bundled"));
  expect(evidence.catalogSource).toBe("codex-bundled");
  try {
    verify(evidence);
  } catch (error) {
    const failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const path = await Effect.runPromise(persistEffectiveRuntimeFailure(evidence, failure));
    throw new Error(`${failure}\nDetailed runtime evidence: ${path}`);
  }
}

function expectGenericSentinel(
  evidence: EffectiveRuntimeEvidence,
  expectedType: (typeof GENERIC_BUILTIN_AGENT_TYPES)[number],
): void {
  expect(evidence.specialistRequests.length).toBeGreaterThan(0);
  const instructionSets = evidence.specialistRequests.map(developerInstructions);
  expect(
    instructionSets.some((text) =>
      text.includes(
        `This is HolyCodex's fail-closed sentinel for the generic \`${expectedType}\` route.`,
      ),
    ),
  ).toBe(true);
  for (const request of evidence.specialistRequests) {
    expect(request["model"]).toBe("gpt-6-luna");
    expectLeafTools(request);
    expect(developerInstructions(request)).not.toContain(
      "Root owns user interaction. Send an intermediate update only when it changes a Root decision",
    );
    expect(developerInstructions(request)).not.toContain(
      "Root delegates all delegable execution and discovery through bounded Assignments; Root owns",
    );
  }
  const sentinelConfig = evidence.projectedAgentConfigs[`sentinel-${expectedType}`];
  expect(sentinelConfig).toBeDefined();
  if (sentinelConfig === undefined) throw new Error(`Missing ${expectedType} sentinel config.`);
  expect(readTomlPath(parseConfig(sentinelConfig), "personality")).toBe(
    evidence.expectedChildPersonality,
  );
  const responseTexts = evidence.specialistResponses.flatMap((response) =>
    outputItems(response, "message").flatMap((item) =>
      Array.isArray(item["content"])
        ? item["content"].flatMap((content) =>
            typeof content === "object" &&
            content !== null &&
            typeof (content as JsonObject)["text"] === "string"
              ? [(content as JsonObject)["text"] as string]
              : [],
          )
        : [],
    ),
  );
  expect(responseTexts).toContain(`HOLYCODEX_SENTINEL_ACTIVE:${expectedType}`);
  expect(evidence.specialistToolCalls).toHaveLength(0);
  expect(evidence.specialistToolResults).toHaveLength(0);
}

function expectGenericRouteBehavior(
  evidence: EffectiveRuntimeEvidence,
  expectedType: (typeof GENERIC_BUILTIN_AGENT_TYPES)[number],
): void {
  expect(calls(evidence, "spawn_agent")).toHaveLength(1);
  expect(calls(evidence, "wait_agent")).toHaveLength(1);
  expect(calls(evidence, "close_agent")).toHaveLength(1);
  expectWaitContract(evidence);
  expectLifecycleClosed(evidence);
  const result = evidence.rootToolResults.find((item) => item["call_id"] === "root-spawn");
  expect(result).toBeDefined();
  const outputValue = result?.["output"] ?? "";
  const output = typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue);
  expect(output).toMatch(/agent_id/iu);
  expectGenericSentinel(evidence, expectedType);
}

function assertRootContract(evidence: EffectiveRuntimeEvidence): void {
  const names = evidence.rootTools.map(
    (tool) => `${String(tool["namespace"])}.${String(tool["name"])}`,
  );
  expect(evidence.codexVersion).toMatch(/^codex-cli\s+0\./u);
  expect(evidence.parentPersonality).toBe("pragmatic");
  expect(evidence.expectedChildPersonality).toBe("none");
  expect(evidence.rootRequest["model"]).toBe("gpt-6.1-sol");
  expect(evidence.rootSupportsSearchTool).toBe(true);
  const projected = parseConfig(evidence.projectedConfig);
  expect(readTomlPath(projected, "features.skill_search")).toBe(true);
  expect(readTomlPath(projected, "features.code_mode.direct_only_tool_namespaces")).toEqual([
    "multi_agent_v1",
  ]);
  expect(readTomlPath(parseConfig(evidence.projectedConfig), "personality")).toBe(
    evidence.parentPersonality,
  );
  expect(names).toContain("multi_agent_v1.spawn_agent");
  expect(names).toContain("multi_agent_v1.wait_agent");
  expect(names).not.toContain("multi_agent_v2.spawn_agent");
  // Search support comes from the current model catalog, outside direct-only V1 routing.
  expectRenderedSections(evidence.rootRequest, evidence.rootBaseInstructions, [
    ["# When to ask the user for permission\n", "# Autonomy and persistence\n"],
    ["# Working with the user\n", "# Rules for getting work done\n"],
    ["# Rules for getting work done\n", "# Using skills\n"],
  ]);
}

function expectActualProjectedAgentInstructions(
  evidence: EffectiveRuntimeEvidence,
  request: Record<string, unknown>,
  agentType: string,
): void {
  const config = evidence.projectedAgentConfigs[agentType];
  expect(config).toBeDefined();
  if (config === undefined) throw new Error(`Missing projected ${agentType} config.`);
  const expected = readTomlPath(parseConfig(config), "developer_instructions");
  expect(typeof expected).toBe("string");
  if (typeof expected !== "string") throw new Error(`Missing ${agentType} instructions.`);

  const actual = developerInstructions(request);
  expect(actual).toContain(expected);
  expect(occurrences(actual, expected)).toBe(1);
  expect(expected).toContain("Independently exercise the assigned local behavior");
  expect(expected).toContain("Keep all implementation, repair, or proof within the assigned scope");
  expect(expected).toContain("Execute only the bounded Assignment");
  expect(expected).toContain("Return exactly one compact, evidence-first terminal outcome");
  expect(expected.indexOf("Independently exercise the assigned local behavior")).toBeLessThan(
    expected.indexOf("Keep all implementation, repair, or proof within the assigned scope"),
  );
  expect(occurrences(expected, "Independently exercise the assigned local behavior")).toBe(1);
  expect(
    expected.indexOf("Keep all implementation, repair, or proof within the assigned scope"),
  ).toBeLessThan(expected.indexOf("Execute only the bounded Assignment"));
  expect(expected.indexOf("Execute only the bounded Assignment")).toBeLessThan(
    expected.indexOf("Return exactly one compact, evidence-first terminal outcome"),
  );
  expect(occurrences(expected, "Execute only the bounded Assignment")).toBe(1);
  expect(
    occurrences(expected, "Keep all implementation, repair, or proof within the assigned scope"),
  ).toBe(1);
  expect(occurrences(expected, "Return exactly one compact, evidence-first terminal outcome")).toBe(
    1,
  );
}

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

function expectWaitContract(evidence: EffectiveRuntimeEvidence): void {
  const call = calls(evidence, "wait_agent")[0];
  const args = argumentsOf(call);
  expect(args["timeout_ms"]).toBe(600000);
  expect(Array.isArray(args["targets"])).toBe(true);
  expect((args["targets"] as unknown[]).length).toBe(1);
}

function expectLifecycleClosed(evidence: EffectiveRuntimeEvidence): void {
  const spawnResult = evidence.rootToolResults.find((item) => item["call_id"] === "root-spawn");
  const result = parseToolOutput(spawnResult);
  const agentId = result["agent_id"];
  expect(typeof agentId).toBe("string");
  const waitArgs = argumentsOf(calls(evidence, "wait_agent")[0]);
  expect(waitArgs["targets"]).toEqual([agentId]);
  const waitResult = evidence.rootToolResults.find((item) => item["call_id"] === "root-wait");
  const waitOutput = parseToolOutput(waitResult);
  expect(waitOutput["timed_out"]).toBe(false);
  const statuses = waitOutput["status"];
  expect(typeof statuses).toBe("object");
  expect((statuses as JsonObject)[String(agentId)]).toHaveProperty("completed");
  const closeArgs = argumentsOf(calls(evidence, "close_agent")[0]);
  expect(closeArgs["target"] ?? closeArgs["agent_id"]).toBe(agentId);
  const closeResult = evidence.rootToolResults.find((item) => item["call_id"] === "root-close");
  expect(closeResult).toBeDefined();
  const closed = parseToolOutput(closeResult);
  expect(closed).toHaveProperty("previous_status");
}

function parseToolOutput(result: JsonObject | undefined): JsonObject {
  const output = result?.["output"];
  if (typeof output !== "string") throw new Error("Expected a JSON tool result from Codex.");
  return JSON.parse(output) as JsonObject;
}

function expectLeafTools(request: Record<string, unknown>): void {
  const names = toolNames(request);
  expect(
    names.some((name) =>
      /^(?:multi_agent_v[12]|collaboration|request_permissions)(?:\.|$)|(?:^|\.)request_user_input(?:_async)?$/u.test(
        name,
      ),
    ),
  ).toBe(false);
}

function calls(evidence: EffectiveRuntimeEvidence, name: string): JsonObject[] {
  return evidence.rootToolCalls.filter(
    (call) => call["namespace"] === "multi_agent_v1" && call["name"] === name,
  );
}

function argumentsOf(call: JsonObject | undefined): JsonObject {
  if (call === undefined) throw new Error("The local Codex provider emitted no expected V1 call.");
  return JSON.parse(String(call["arguments"])) as JsonObject;
}

function toolNames(request: Record<string, unknown>): string[] {
  const input = request["input"];
  if (!Array.isArray(input)) return [];
  const groups = input.filter(
    (value): value is JsonObject =>
      typeof value === "object" &&
      value !== null &&
      (value as JsonObject)["type"] === "additional_tools",
  );
  return groups.flatMap((group) =>
    (Array.isArray(group["tools"]) ? group["tools"] : []).flatMap((tool) => {
      if (typeof tool !== "object" || tool === null) return [];
      const entry = tool as JsonObject;
      if (entry["type"] === "namespace" && Array.isArray(entry["tools"])) {
        return entry["tools"].flatMap((nested) => {
          if (typeof nested !== "object" || nested === null) return [];
          const name = (nested as JsonObject)["name"];
          return typeof name === "string" ? [`${String(entry["name"])}.${name}`] : [];
        });
      }
      const name = entry["name"];
      return typeof name === "string" ? [name] : [];
    }),
  );
}

function outputItems(request: Record<string, unknown>, type: string): JsonObject[] {
  const output = request["input"];
  return Array.isArray(output)
    ? output.filter(
        (item): item is JsonObject =>
          typeof item === "object" && item !== null && (item as JsonObject)["type"] === type,
      )
    : [];
}

function developerInstructions(request: Record<string, unknown>): string {
  const input = request["input"];
  if (!Array.isArray(input)) return "";
  return input
    .flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const message = entry as JsonObject;
      if (
        message["type"] !== "message" ||
        message["role"] !== "developer" ||
        !Array.isArray(message["content"])
      )
        return [];
      return message["content"].flatMap((content) => {
        if (typeof content !== "object" || content === null) return [];
        const text = (content as JsonObject)["text"];
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("\n");
}

function modelBaseInstructions(request: Record<string, unknown>): string {
  return developerLayerInstructions(request)[0] ?? "";
}

function developerLayerInstructions(request: Record<string, unknown>): string[] {
  const input = request["input"];
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry as JsonObject)["type"] !== "message" ||
      (entry as JsonObject)["role"] !== "developer" ||
      !Array.isArray((entry as JsonObject)["content"])
    )
      return [];
    return ((entry as JsonObject)["content"] as unknown[]).flatMap((content) => {
      if (typeof content !== "object" || content === null) return [];
      const text = (content as JsonObject)["text"];
      return typeof text === "string" ? [text] : [];
    });
  });
}

function expectRenderedSections(
  request: Record<string, unknown>,
  source: string,
  sections: readonly (readonly [string, string])[],
): void {
  const rendered = modelBaseInstructions(request);
  expect(rendered.length).toBeGreaterThan(0);
  for (const [start, end] of sections) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(source.indexOf(start, startIndex + start.length)).toBe(-1);
    expect(source.indexOf(end, endIndex + end.length)).toBe(-1);
    expect(rendered).toContain(source.slice(startIndex, endIndex));
  }
}

type JsonObject = Record<string, unknown>;
