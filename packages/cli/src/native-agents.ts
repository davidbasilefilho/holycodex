// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import {
  ROLE_DEFINITIONS,
  lookupPlan,
  nativeAgentTypeFor,
  taskInstructionFor,
  type NativeAgentType,
  type PlanName,
  type RoleTask,
} from "@holycodex/core";
import { writeAtomicText } from "./storage.ts";

export type NativeAgentProjection = Readonly<{
  name: NativeAgentType;
  rolePolicy: (typeof ROLE_DEFINITIONS)[number];
  taskInstruction: string;
  model: "gpt-5.6-luna";
  effort: string;
}>;

export function projectNativeAgents(planName: PlanName): readonly NativeAgentProjection[] {
  const plan = lookupPlan(planName);
  if (!plan.ok || !plan.value.workflowEnabled) return [];
  return plan.value.routes.map((route) => {
    const roleTask = { role: route.role, task: route.task } as RoleTask;
    return {
      name: nativeAgentTypeFor(roleTask),
      rolePolicy: ROLE_DEFINITIONS.find((definition) => definition.role === route.role)!,
      taskInstruction: taskInstructionFor(roleTask),
      model: "gpt-5.6-luna",
      effort: route.effort,
    };
  });
}

export async function installNativeAgents(codexHome: string, plan: PlanName): Promise<void> {
  const root = join(codexHome, "agents");
  for (const agent of projectNativeAgents(plan)) {
    await writeAtomicText(join(root, `${agent.name}.toml`), renderNativeAgent(agent));
  }
}

function renderNativeAgent(agent: NativeAgentProjection): string {
  const shared = agent.rolePolicy;
  const instructions = [
    `${shared.role} shared policy: ${shared.authority}`,
    shared.evidence,
    shared.completion,
    agent.taskInstruction,
    `Use shared role skills: ${shared.skills.join(", ") || "none"}.`,
  ].join("\n");
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(`${shared.role} ${agent.name.split(".")[1]} specialist.`)}`,
    `model = ${JSON.stringify(agent.model)}`,
    `model_reasoning_effort = ${JSON.stringify(agent.effort)}`,
    `sandbox_mode = ${JSON.stringify(shared.permissions.write ? "workspace-write" : "read-only")}`,
    `developer_instructions = ${JSON.stringify(instructions)}`,
    "",
  ].join("\n");
}
