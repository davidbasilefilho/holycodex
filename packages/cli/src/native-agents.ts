// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  ROLE_DEFINITIONS,
  NATIVE_AGENT_TYPES,
  ROOT_ORCHESTRATION_POLICY,
  SURGICAL_MUTATION_RULE,
  lookupProfile,
  nativeAgentTypeFor,
  taskDescriptionFor,
  taskInstructionFor,
  taskPermissionsFor,
  type ServiceTier,
  type NativeAgentType,
  type ProfileName,
  type RoleTask,
} from "@holycodex/core";

import { assertNoSymlink, isFsCode, pathWithin } from "./paths.ts";
import { writeAtomicText } from "./storage.ts";
import type { ManagedArtifact } from "./types.ts";

export type NativeAgentProjection = Readonly<{
  name: NativeAgentType;
  rolePolicy: (typeof ROLE_DEFINITIONS)[number];
  taskInstruction: string;
  model: "gpt-5.6-luna";
  effort: string;
  description: string;
  serviceTier: "default" | "fast";
  permissions: ReturnType<typeof taskPermissionsFor>;
}>;

export type RootAgentProjection = Readonly<{
  name: "root";
  description: string;
  model: "gpt-6-astra";
  effort: string;
  serviceTier: "default" | "fast";
}>;

const LUNA_BASELINE_POLICY =
  "You are a HolyCodex GPT-5.6 Luna specialist executing one active bounded Assignment. Follow its exact boundary, exclusions, acceptance criteria, and evidence requirements. Preserve unrelated work and perform no redundant operations. Do not delegate, message peers, mutate global Intent lifecycle, make material decisions, or perform Git/VCS. Repository source mutation is governed only by the concrete task contract; workspace writes for caches, generated test state, and proof outputs do not grant source-mutation authority. Return exactly one compact outcome (`completed`, `blocked`, `needs_root_input`, or `failed`) with changed paths, checks, observable evidence, blockers, and remaining risk.";

export interface NativeAgentInstallResult {
  readonly managed_artifacts: readonly ManagedArtifact[];
  readonly preserved: readonly string[];
  readonly rollback: readonly NativeAgentRollbackEntry[];
}

export interface NativeAgentRollbackEntry {
  readonly path: string;
  readonly previous: string | undefined;
  readonly installedDigest: string | undefined;
}

export interface NativeAgentRemovalResult {
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
}

/** Project every canonical specialist profile and service tier. */
export function projectNativeAgents(
  profileName: ProfileName,
  tier: ServiceTier = "standard",
): readonly NativeAgentProjection[] {
  const profile = lookupProfile(profileName);
  if (!profile.ok) return [];
  return profile.value.routes.map((route) => {
    const roleTask = { role: route.role, task: route.task } as RoleTask;
    return {
      name: nativeAgentTypeFor(roleTask),
      rolePolicy: ROLE_DEFINITIONS.find((definition) => definition.role === route.role)!,
      description: taskDescriptionFor(roleTask),
      taskInstruction: taskInstructionFor(roleTask),
      permissions: taskPermissionsFor(roleTask),
      model: "gpt-5.6-luna",
      effort: route.effort,
      serviceTier: tier === "standard" ? "default" : "fast",
    };
  });
}

/** Project the parent Root model configuration for a profile and service tier. */
export function projectRootAgent(
  profileName: ProfileName,
  tier: ServiceTier = "standard",
): RootAgentProjection {
  const profile = lookupProfile(profileName);
  if (!profile.ok) throw new Error("Unknown profile.");
  return {
    name: "root",
    description: "Root-directed HolyCodex control agent.",
    model: profile.value.root.model,
    effort: profile.value.root.effort,
    serviceTier: tier === "fast-all" ? "fast" : "default",
  };
}

/** The parent session is configured in config.toml, never as a spawnable role. */
export function rootDeveloperInstructions(computerUse = false): string {
  if (
    !ROOT_ORCHESTRATION_POLICY.requiresDelegation ||
    !ROOT_ORCHESTRATION_POLICY.trivialWorkRequiresDelegation ||
    !ROOT_ORCHESTRATION_POLICY.codeReviewRequiredForImplementation ||
    !ROOT_ORCHESTRATION_POLICY.codeReviewRequiredBeforeVcs ||
    !ROOT_ORCHESTRATION_POLICY.externalVerificationMustBeTerminal
  ) {
    throw new Error("The Root orchestration policy is incomplete.");
  }
  const instructions = [
    "You are the HolyCodex Root/session orchestrator running gpt-6-astra. Own the user goal, acceptance, material product or architecture choices, lifecycle, integration, external effects, and final completion.",
    "Represent every specialist work unit, including repository discovery, source inspection, fact finding, and trivial work, with one active bounded Assignment. For repository implementation, research, testing, review, CI observation, or inspecting source/tests/docs/generated artifacts, Root's first action is to create and start that Assignment and dispatch the native Explorer, Librarian, Worker, or Reviewer route before inspecting anything itself. Root may inspect only returned evidence for integration acceptance. Small work may use one Assignment. Git/VCS, GUI, and browser execution are Root-only. Do the underlying repository implementation, research, testing, review, and CI observation through specialists.",
    "Use holycodex-agent semantic operations for Intent, optional Plan, and Assignment state. Never edit TOON state or create standalone handoff, Decision, or blocker files.",
    "Infer routine safe choices and keep moving. Finish authorized read-only, reversible, preparatory, and independent work before asking. Use request_user_input only for a material unresolved choice, an explicit approval boundary such as plan approval, installation profile approval, remote/origin/server VCS mutation, or public publication/release, or a genuine blocker that can change the outcome, and persist the resulting needs_root_input state.",
    "Dispatch independent non-overlapping Assignments concurrently when useful, keep dependent phases ordered, and serialize writes to one mutable seam. Use writing-for-agents to author compact Luna contracts without repeating effective receiver instructions.",
    "For complex work, make each phase a coherent dependency, decision, or integration boundary. Resolve only choices needed by the current phase, persist its Plan and Assignment evidence, and advance after acceptance; do not ask later-phase questions prematurely.",
    "Use proportional proof and inspect specialist evidence before integration. Worker.validation is an optional independent local proof route when risk or integration complexity warrants it; it does not replace implementation proof or Reviewer.code. Reviewer.code fixed-point review is mandatory after implementation or a major codebase change and before completion or VCS, with no recursive review or testing ceremony.",
    "After integration, Root performs approved VCS actions and dispatches Worker.operations with the exact ref or SHA for terminal CI or release evidence. Pending is never success. Discover the actual topology; repair failures through bounded Assignments and repeat integration, fixed-point review, VCS, and terminal observation until the applicable gate is green.",
  ];
  if (computerUse) {
    instructions.push(
      "Computer Use is selected and is directly executable by Root/session only; it must not be delegated.",
    );
  } else {
    instructions.push(
      "Computer Use is unavailable for this installation and cannot be delegated. GUI and browser execution remain Root/session-only.",
    );
  }
  return instructions.join("\n");
}

/** Publish canonical native profiles while preserving foreign or modified files. */
export async function installNativeAgents(
  codexHome: string,
  profile: ProfileName,
  previous: readonly ManagedArtifact[] = [],
  tier: ServiceTier = "standard",
): Promise<NativeAgentInstallResult> {
  const root = join(codexHome, "holycodex", "agents");
  const preserved: string[] = [];
  const rollback: NativeAgentRollbackEntry[] = [];
  const projections = projectNativeAgents(profile, tier).map((agent) => ({
    path: join(root, `${agent.name}.toml`),
    contents: renderNativeAgent(agent),
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
  try {
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
        rollback.push({
          path: projection.path,
          previous: current,
          installedDigest: await sha256(projection.contents),
        });
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
    const legacyRootContents = await readRegularFile(legacyRoot);
    const legacyRootStatus = await removeLegacyRootIfOwned(legacyRoot);
    if (legacyRootStatus === "preserved") preserved.push(legacyRoot);
    if (legacyRootStatus === "removed" && legacyRootContents !== undefined) {
      rollback.push({ path: legacyRoot, previous: legacyRootContents, installedDigest: undefined });
    }
    for (const artifact of previous) {
      const absolute = join(codexHome, artifact.path);
      if (!projections.some((candidate) => candidate.path === absolute)) {
        if (!isKnownLegacyNativePath(codexHome, absolute, artifact.path)) {
          preserved.push(absolute);
          continue;
        }
        const status = await removeIfUnchanged(absolute, artifact.digest);
        if (status.status === "preserved") preserved.push(absolute);
        else if (status.previous !== undefined) {
          rollback.push({ path: absolute, previous: status.previous, installedDigest: undefined });
        }
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
    return { managed_artifacts, preserved, rollback };
  } catch (error: unknown) {
    // The caller cannot receive a result when a write fails midway. Restore
    // everything already published while preserving concurrent user edits.
    await rollbackNativeAgentInstall(rollback).catch(() => undefined);
    throw error;
  }
}

/** Restore only files that still match the just-published native-agent state. */
export async function rollbackNativeAgentInstall(
  entries: readonly NativeAgentRollbackEntry[],
): Promise<NativeAgentRemovalResult> {
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const entry of [...entries].reverse()) {
    const current = await readRegularFile(entry.path);
    const unchanged =
      entry.installedDigest === undefined
        ? current === undefined
        : current !== undefined && (await sha256(current)) === entry.installedDigest;
    if (!unchanged) {
      preserved.push(entry.path);
      continue;
    }
    if (entry.previous === undefined) {
      await rm(entry.path, { force: false }).catch((error: unknown) => {
        if (!isFsCode(error, "ENOENT")) throw error;
      });
      removed.push(entry.path);
    } else {
      await writeAtomicText(entry.path, entry.previous);
    }
  }
  return { removed, preserved };
}

/** Remove only unchanged native profiles recorded as HolyCodex-owned artifacts. */
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
      if (!isFsCode(error, "ENOENT")) preserved.push(target);
    }
  }
  const legacyRoot = join(codexHome, "agents", "root.toml");
  const legacyRootStatus = await removeLegacyRootIfOwned(legacyRoot);
  if (legacyRootStatus === "removed") removed.push(legacyRoot);
  if (legacyRootStatus === "preserved") preserved.push(legacyRoot);
  return { removed, preserved };
}

/** Render one canonical native specialist profile as Codex TOML. */
export function renderNativeAgent(agent: NativeAgentProjection): string {
  const instructions = [
    LUNA_BASELINE_POLICY,
    agent.taskInstruction,
    ...(agent.permissions.sourceMutation
      ? [`Surgical mutation rule: ${SURGICAL_MUTATION_RULE}`]
      : []),
  ].join("\n");
  const sandboxMode = nativeAgentSandboxMode(agent);
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `model = ${JSON.stringify(agent.model)}`,
    `model_reasoning_effort = ${JSON.stringify(agent.effort)}`,
    `service_tier = ${JSON.stringify(agent.serviceTier)}`,
    'model_reasoning_summary = "none"',
    'model_verbosity = "low"',
    `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    'approval_policy = "never"',
    `web_search = ${JSON.stringify(agent.permissions.network ? "live" : "disabled")}`,
    `developer_instructions = ${JSON.stringify(instructions)}`,
    "",
    "[agents]",
    "enabled = false",
    "interrupt_message = false",
    "",
    "[features]",
    "context_management = true",
    "multi_agent_v2 = false",
    "multi_agent = false",
    "computer_use = false",
    "browser_use = false",
    "in_app_browser = false",
    "",
  ].join("\n");
}

/** Return the Codex sandbox mode for a concrete task, including proof-only writable tasks. */
export function nativeAgentSandboxMode(
  agent: NativeAgentProjection,
): "workspace-write" | "read-only" {
  return agent.permissions.filesystem === "workspace-write" ? "workspace-write" : "read-only";
}

function renderHistoricalRootAgent(
  model: "gpt-5.6-terra" | "gpt-5.6-sol",
  effort: string,
  serviceTier: "default" | "fast",
): string {
  return [
    'name = "root"',
    'description = "Root-directed HolyCodex control agent."',
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(effort)}`,
    `service_tier = ${JSON.stringify(serviceTier)}`,
    'model_verbosity = "low"',
    "",
  ].join("\n");
}

// Previous releases wrote only these exact root-role layouts. Keep the
// allowlist closed over their historical Terra/Sol profile and tier output;
// a user-owned root role with even a small shape/content difference is not
// ours to remove.
const LEGACY_ROOT_ROLE_CONTENTS = new Set(
  (
    [
      { model: "gpt-5.6-terra", effort: "high" },
      { model: "gpt-5.6-sol", effort: "low" },
      { model: "gpt-5.6-sol", effort: "medium" },
      { model: "gpt-5.6-sol", effort: "high" },
    ] as const
  ).flatMap(({ model, effort }) =>
    (["default", "fast"] as const).map((serviceTier) =>
      renderHistoricalRootAgent(model, effort, serviceTier),
    ),
  ),
);

/** Identify the closed set of legacy HolyCodex Root files safe to remove. */
export function isKnownLegacyRootRoleContent(content: string): boolean {
  return LEGACY_ROOT_ROLE_CONTENTS.has(content);
}

function isKnownLegacyNativePath(
  codexHome: string,
  absolute: string,
  relativePath: string,
): boolean {
  if (relativePath === "agents/root.toml") return true;
  if (
    ROLE_DEFINITIONS.some(
      (definition) => relativePath === `holycodex/agents/${definition.role.toLowerCase()}.toml`,
    )
  ) {
    return true;
  }
  if (!pathWithin(join(codexHome, "agents"), absolute)) return false;
  return NATIVE_AGENT_TYPES.some((agentType) => {
    const [role, task] = agentType.split(".");
    const legacyName = `${role![0]!.toUpperCase()}${role!.slice(1)}.${task}.toml`;
    return relativePath === `agents/${legacyName}`;
  });
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

async function removeIfUnchanged(
  path: string,
  digest: string,
): Promise<Readonly<{ status: "removed" | "preserved"; previous?: string }>> {
  try {
    await assertNoSymlink(path);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) return { status: "preserved" };
    const previous = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    if ((await sha256(previous)) === digest) {
      await rm(path, { force: false });
      return { status: "removed", previous };
    }
    return { status: "preserved" };
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return { status: "removed" };
    throw error;
  }
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
