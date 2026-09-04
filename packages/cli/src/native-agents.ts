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

type NativeRoleProjection = Readonly<{
  readonly role: "explorer" | "librarian" | "worker" | "reviewer";
  readonly description: string;
  readonly model: "gpt-5.6-luna";
  readonly effort: string;
  readonly serviceTier: "default" | "fast";
  readonly instructions: string;
}>;

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

/** The parent session is configured in config.toml, never as a spawnable role. */
export function rootDeveloperInstructions(): string {
  return [
    "You are the HolyCodex Root orchestrator.",
    "Own user intent, scope, architecture, product and policy choices, material risk, integration, external state, and final readiness.",
    "Delegate every substantive non-VCS operation to one named native Explorer, Librarian, Worker, or Reviewer with an exact bounded scope and observable completion criterion.",
    "Before delegation, ensure writing-for-agents is fully loaded and applied in the active context. For any applicable skill, fully load it on first use in the active context, reuse it while its complete instructions remain available, and reload only after compaction, a new context, or an incomplete or unavailable load.",
    "Inspect and integrate returned evidence; do not blindly accept conclusions. Keep Git/VCS inspection and mutation Root-only.",
    "Use request_user_input whenever user information or approval is required and available; do not replace it with a prose question.",
    "Keep changes minimal, mergeable, and within the assigned seam. Preserve unrelated user state and fail closed on ambiguity or conflict.",
  ].join("\n");
}

export async function installNativeAgents(
  codexHome: string,
  plan: PlanName,
  previous: readonly ManagedArtifact[] = [],
  tier: ServiceTier = "standard",
): Promise<NativeAgentInstallResult> {
  const root = join(codexHome, "holycodex", "agents");
  const preserved: string[] = [];
  const projections = projectNativeRoles(plan, tier).map((agent) => ({
    path: join(root, `${agent.role}.toml`),
    contents: renderNativeRole(agent),
  }));
  const previousByPath = new Map(
    previous.map((artifact) => [join(codexHome, artifact.path), artifact]),
  );
  const currentByPath = new Map<string, string | undefined>();
  for (const projection of projections) {
    const current = await readRegularFile(projection.path);
    currentByPath.set(projection.path, current);
    const previousArtifact = previousByPath.get(projection.path);
    if (
      current !== undefined &&
      previousArtifact === undefined &&
      current !== projection.contents
    ) {
      throw new Error(
        `A pre-existing HolyCodex role file is not owned by this installation: ${projection.path}`,
      );
    }
  }
  const managed_artifacts: ManagedArtifact[] = [];
  for (const projection of projections) {
    const current = currentByPath.get(projection.path);
    const previousArtifact = previousByPath.get(projection.path);
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
      await writeAtomicText(projection.path, projection.contents);
    }
    managed_artifacts.push({
      path: relative(codexHome, projection.path).replaceAll("\\", "/"),
      digest: await sha256(projection.contents),
    });
  }
  // A legacy root role was invalid by construction. Remove it only when its
  // content carries the old HolyCodex marker; an unrelated user root role is
  // preserved.
  const legacyRoot = join(codexHome, "agents", "root.toml");
  const legacyRootStatus = await removeLegacyRootIfOwned(legacyRoot);
  if (legacyRootStatus === "preserved") preserved.push(legacyRoot);
  for (const artifact of previous) {
    const absolute = join(codexHome, artifact.path);
    if (!projections.some((candidate) => candidate.path === absolute)) {
      if (!isKnownLegacyNativePath(codexHome, absolute, artifact.path)) {
        preserved.push(absolute);
        continue;
      }
      const status = await removeIfUnchanged(absolute, artifact.digest);
      if (status === "preserved") preserved.push(absolute);
    }
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
  const managedRoot = join(codexHome, "holycodex", "agents");
  for (const artifact of artifacts) {
    const target = join(codexHome, artifact.path);
    if (
      !pathWithin(codexHome, target) ||
      (!pathWithin(root, target) &&
        !pathWithin(managedRoot, target) &&
        target !== join(codexHome, "config.toml"))
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
  const legacyRoot = join(codexHome, "agents", "root.toml");
  const legacyRootStatus = await removeLegacyRootIfOwned(legacyRoot);
  if (legacyRootStatus === "removed") removed.push(legacyRoot);
  if (legacyRootStatus === "preserved") preserved.push(legacyRoot);
  return { removed, preserved };
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
    `developer_instructions = ${JSON.stringify(`${instructions}\nExecute only the assigned scope, escalate material decisions to Root, and return evidence/results to Root.`)}`,
    "",
    "[agents]",
    "enabled = false",
    "interrupt_message = false",
    "",
    "[features]",
    "multi_agent_v2 = false",
    "multi_agent = false",
    "",
  ].join("\n");
}

function projectNativeRoles(
  planName: PlanName,
  tier: ServiceTier,
): readonly NativeRoleProjection[] {
  const projected = projectNativeAgents(planName, tier);
  const roles = ["explorer", "librarian", "worker", "reviewer"] as const;
  return roles.map((role) => {
    const matching = projected.filter((agent) => agent.name.toLowerCase().startsWith(`${role}.`));
    const first = matching[0];
    if (!first) throw new Error(`Plan does not define the ${role} role.`);
    const effort = matching.reduce(
      (current, agent) => maxEffort(current, agent.effort),
      first.effort,
    );
    const descriptions = matching.map((agent) => agent.description).join(" ");
    const rolePolicy = first.rolePolicy;
    return {
      role,
      description: `${rolePolicy.role}: ${descriptions}`,
      model: first.model,
      effort,
      serviceTier: first.serviceTier,
      instructions: [
        `${rolePolicy.role} shared policy: ${rolePolicy.authority}`,
        rolePolicy.evidence,
        rolePolicy.completion,
        ...matching.map((agent) => agent.taskInstruction),
      ].join("\n"),
    };
  });
}

function renderNativeRole(agent: NativeRoleProjection): string {
  return [
    `name = ${JSON.stringify(agent.role)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `model = ${JSON.stringify(agent.model)}`,
    `model_reasoning_effort = ${JSON.stringify(agent.effort)}`,
    `service_tier = ${JSON.stringify(agent.serviceTier)}`,
    'model_reasoning_summary = "none"',
    'model_verbosity = "low"',
    "tool_output_token_limit = 12000",
    `developer_instructions = ${JSON.stringify(`${agent.instructions}\nExecute only the assigned scope, escalate material decisions to Root, and return evidence/results to Root.`)}`,
    "",
    "[agents]",
    "enabled = false",
    "interrupt_message = false",
    "",
    "[features]",
    "multi_agent_v2 = false",
    "multi_agent = false",
    "",
  ].join("\n");
}

function renderLegacyRootAgent(agent: RootAgentProjection): string {
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

// Previous releases wrote only this exact root-role layout. Keep the
// allowlist closed over the plan/tier projections those releases could emit;
// a user-owned root role with even a small shape/content difference is not
// ours to remove.
const LEGACY_ROOT_ROLE_CONTENTS = new Set(
  (["go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"] as const).flatMap((plan) =>
    (["standard", "fast", "fast-all"] as const).map((tier) =>
      renderLegacyRootAgent(projectRootAgent(plan, tier)),
    ),
  ),
);

export function isKnownLegacyRootRoleContent(content: string): boolean {
  return LEGACY_ROOT_ROLE_CONTENTS.has(content);
}

function maxEffort(left: string, right: string): string {
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
  return (rank[right] ?? 0) > (rank[left] ?? 0) ? right : left;
}

function isKnownLegacyNativePath(
  codexHome: string,
  absolute: string,
  relativePath: string,
): boolean {
  if (relativePath === "agents/root.toml") return true;
  return (
    pathWithin(join(codexHome, "agents"), absolute) &&
    /^(?:Explorer|Librarian|Worker|Reviewer)\.(?:lookup|trace|research|mechanical|implementation|integration|operations|plan|code|artifact)\.toml$/u.test(
      relativePath.slice("agents/".length),
    )
  );
}

async function removeLegacyRootIfOwned(path: string): Promise<"removed" | "preserved" | "absent"> {
  try {
    await assertNoSymlink(path);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return "preserved";
    const content = await readFile(path, "utf8");
    if (!isKnownLegacyRootRoleContent(content)) {
      return "preserved";
    }
    await rm(path, { force: false });
    return "removed";
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return "absent";
    throw error;
  }
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
