// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ROLE_DEFINITIONS,
  lookupPlan,
  nativeAgentTypeFor,
  taskDescriptionFor,
  taskInstructionFor,
  type ServiceTier,
  type NativeAgentType,
  type PlanName,
  type RoleTask,
} from "@holycodex/core";
import { writeAtomicText } from "./storage.ts";
import { assertNoSymlink, isFsCode, pathWithin } from "./paths.ts";
import type { ManagedArtifact } from "./types.ts";

export type NativeAgentProjection = Readonly<{
  name: NativeAgentType;
  rolePolicy: (typeof ROLE_DEFINITIONS)[number];
  taskInstruction: string;
  model: "gpt-5.6-luna";
  effort: string;
  description: string;
  serviceTier: "default" | "fast";
}>;

export type RootAgentProjection = Readonly<{
  name: "root";
  description: string;
  model: "gpt-5.6-terra" | "gpt-5.6-sol";
  effort: string;
  serviceTier: "default" | "fast";
}>;

export interface NativeAgentInstallResult {
  readonly managed_artifacts: readonly ManagedArtifact[];
  readonly preserved: readonly string[];
}

export interface NativeAgentRemovalResult {
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
}

export function projectNativeAgents(
  planName: PlanName,
  tier: ServiceTier = "standard",
): readonly NativeAgentProjection[] {
  const plan = lookupPlan(planName);
  if (!plan.ok) return [];
  return plan.value.routes.map((route) => {
    const roleTask = { role: route.role, task: route.task } as RoleTask;
    return {
      name: nativeAgentTypeFor(roleTask),
      rolePolicy: ROLE_DEFINITIONS.find((definition) => definition.role === route.role)!,
      description: taskDescriptionFor(roleTask),
      taskInstruction: taskInstructionFor(roleTask),
      model: "gpt-5.6-luna",
      effort: route.effort,
      serviceTier: tier === "standard" ? "default" : "fast",
    };
  });
}

export function projectRootAgent(
  planName: PlanName,
  tier: ServiceTier = "standard",
): RootAgentProjection {
  const plan = lookupPlan(planName);
  if (!plan.ok) throw new Error("Unknown plan.");
  return {
    name: "root",
    description: "Root-directed HolyCodex control agent.",
    model: plan.value.root.model === "Terra" ? "gpt-5.6-terra" : "gpt-5.6-sol",
    effort: plan.value.root.effort,
    serviceTier: tier === "fast-all" ? "fast" : "default",
  };
}

export async function installNativeAgents(
  codexHome: string,
  plan: PlanName,
  previous: readonly ManagedArtifact[] = [],
  tier: ServiceTier = "standard",
): Promise<NativeAgentInstallResult> {
  const root = join(codexHome, "agents");
  const configPath = join(codexHome, "config.toml");
  const preserved: string[] = [];
  const projections: Array<{ readonly path: string; readonly contents: string }> = [
    { path: join(root, "root.toml"), contents: renderRootAgent(projectRootAgent(plan, tier)) },
    ...projectNativeAgents(plan, tier).map((agent) => ({
      path: join(root, `${agent.name}.toml`),
      contents: renderNativeAgent(agent),
    })),
  ];
  const previousByPath = new Map(
    previous.map((artifact) => [join(codexHome, artifact.path), artifact]),
  );
  for (const artifact of previous) {
    const absolute = join(codexHome, artifact.path);
    if (!projections.some((candidate) => candidate.path === absolute)) {
      if (!pathWithin(root, absolute) && absolute !== configPath) {
        preserved.push(absolute);
        continue;
      }
      const status = await removeIfUnchanged(absolute, artifact.digest);
      if (status === "preserved") preserved.push(absolute);
    }
  }
  const managed_artifacts: ManagedArtifact[] = [];
  for (const projection of projections) {
    const current = await readRegularFile(projection.path);
    const previousArtifact = previousByPath.get(projection.path);
    if (
      current !== undefined &&
      previousArtifact === undefined &&
      current !== projection.contents
    ) {
      preserved.push(projection.path);
      continue;
    }
    if (current !== undefined && previousArtifact !== undefined) {
      const digest = await sha256(current);
      if (digest !== previousArtifact.digest && current !== projection.contents) {
        preserved.push(projection.path);
        managed_artifacts.push({
          path: relative(codexHome, projection.path).replaceAll("\\", "/"),
          digest: previousArtifact.digest,
        });
        continue;
      }
    }
    if (current === undefined || current !== projection.contents) {
      if (current !== undefined && previousArtifact === undefined) {
        preserved.push(projection.path);
        continue;
      }
      await writeAtomicText(projection.path, projection.contents);
    }
    managed_artifacts.push({
      path: relative(codexHome, projection.path).replaceAll("\\", "/"),
      digest: await sha256(projection.contents),
    });
  }
  for (const artifact of previous) {
    const absolute = join(codexHome, artifact.path);
    if (
      preserved.includes(absolute) &&
      !managed_artifacts.some((candidate) => join(codexHome, candidate.path) === absolute)
    ) {
      managed_artifacts.push(artifact);
    }
  }
  return { managed_artifacts, preserved };
}

export async function removeManagedNativeAgents(
  codexHome: string,
  artifacts: readonly ManagedArtifact[],
): Promise<NativeAgentRemovalResult> {
  const removed: string[] = [];
  const preserved: string[] = [];
  const root = join(codexHome, "agents");
  for (const artifact of artifacts) {
    const target = join(codexHome, artifact.path);
    if (
      !pathWithin(codexHome, target) ||
      (!pathWithin(root, target) && target !== join(codexHome, "config.toml"))
    ) {
      preserved.push(target);
      continue;
    }
    try {
      await assertNoSymlink(target);
      const entry = await lstat(target);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        preserved.push(target);
        continue;
      }
      const current = await readFile(target);
      if ((await sha256(current)) !== artifact.digest) {
        preserved.push(target);
        continue;
      }
      await rm(target, { force: false });
      removed.push(target);
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT")) removed.push(target);
      else preserved.push(target);
    }
  }
  return { removed, preserved };
}

function renderRootAgent(agent: RootAgentProjection): string {
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `model = ${JSON.stringify(agent.model)}`,
    `model_reasoning_effort = ${JSON.stringify(agent.effort)}`,
    `service_tier = ${JSON.stringify(agent.serviceTier)}`,
    'model_verbosity = "low"',
    "",
  ].join("\n");
}

export function renderNativeAgent(agent: NativeAgentProjection): string {
  const shared = agent.rolePolicy;
  const instructions = [
    `${shared.role} shared policy: ${shared.authority}`,
    shared.evidence,
    shared.completion,
    agent.taskInstruction,
  ].join("\n");
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `model = ${JSON.stringify(agent.model)}`,
    `model_reasoning_effort = ${JSON.stringify(agent.effort)}`,
    `service_tier = ${JSON.stringify(agent.serviceTier)}`,
    'model_reasoning_summary = "none"',
    'model_verbosity = "low"',
    "tool_output_token_limit = 12000",
    `developer_instructions = ${JSON.stringify(`${instructions}\nReport only to Root. Do not spawn agents, message peers, or delegate work.`)}`,
    "",
    "[agents]",
    "enabled = false",
    "interrupt_message = false",
    "",
    "[features]",
    "multi_agent = false",
    "",
  ].join("\n");
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    await assertNoSymlink(path);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Invalid managed path: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function removeIfUnchanged(path: string, digest: string): Promise<"removed" | "preserved"> {
  try {
    await assertNoSymlink(path);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) return "preserved";
    if ((await sha256(await readFile(path))) === digest) {
      await rm(path, { force: false });
      return "removed";
    }
    return "preserved";
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return "removed";
    throw error;
  }
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
