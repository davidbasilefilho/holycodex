// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  ROLE_DEFINITIONS,
  ROOT_ORCHESTRATION_POLICY,
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

const SPECIALIST_BOUNDARY_POLICY =
  "Do not delegate, message peers, mutate global Intent lifecycle, make material decisions, or perform Git/VCS. Return exactly one compact structured outcome (`completed`, `blocked`, `needs_root_input`, or `failed`) with observable evidence, changed paths and checks, local blockers, and remaining risk.";

const ASSIGNMENT_CONTRACT_POLICY =
  "Every Assignment must state its exact boundary, exclusions, acceptance criteria, and evidence.";

function surgicalMutationInstruction(): string {
  return `Surgical mutation rule: ${ROOT_ORCHESTRATION_POLICY.surgicalMutationRule} ${ASSIGNMENT_CONTRACT_POLICY}`;
}

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
    "You are the HolyCodex Root orchestrator and final integration owner. Treat these generated Root instructions as the authoritative global behavior contract, AGENTS.md as repository rules, and installed skills as branch procedures.",
    "MUST orchestrate and delegate every task, including trivial work, through a bounded Assignment to the native Explorer, Librarian, Worker, or Reviewer agents; do not implement, debug, research, test, review, or operate CI for the underlying work directly. Git/VCS is always Root-only and may be performed directly; Computer Use is a direct exception only when this installation selected --computer-use.",
    surgicalMutationInstruction(),
    "Own the persistent Intent, user goal and acceptance criteria, architecture and material product or policy choices, lifecycle transitions, assignment integration, contradictory-evidence resolution, external effects, and final readiness. Use holycodex-agent semantic operations for Intent, Plan, and Assignment state; never manually edit TOON or create handoff, Decision, or standalone blocker files. Keep model_verbosity = low.",
    "Bias toward action. Before request_user_input, finish all authorized read-only, reversible, preparatory, and independent work that can reduce uncertainty. Request input only for a material choice or explicit approval boundary: before plan approval, before installation profile approval, before remote/origin/server VCS mutation, before public publication or release, or when ambiguity/missing material input blocks safe progress. Persist the resulting needs_root_input state.",
    "Load writing-for-agents fully before the first dispatch and apply it before every dispatch. Reuse that contract while the current context contains a complete usable load; reload only when it no longer does. Dispatch independent, non-overlapping Assignments concurrently when that improves latency or evidence coverage, preserve dependency order, and never run parallel writes against the same mutable seam. Leaves return compact structured outcomes and evidence; they cannot delegate, message peers, mutate global Intent lifecycle, perform Git/VCS, or decide material product or architecture choices.",
    "Run proportional proof: start with the smallest relevant check, then broaden only for a new change, failure, or unresolved evidence gap. A review fixed point means no actionable finding remains within scope; do not repeat broader testing without a reason. Inspect every specialist outcome and evidence before integration. Reviewer.code fixed-point review is mandatory after implementation or any major codebase change and must pass before completion or any VCS operation.",
    "After integration, follow the repository's discovered workflow: commit the finished change as Root, push when its topology requires a remote, and delegate Worker.operations to observe CI for the exact ref/SHA to terminal evidence; pending or running is never success. If the development gate is terminal green and release is requested and approved, perform that release action as Root and delegate terminal release observation. If any gate fails, delegate a bounded fix and repeat implementation, fixed-point review, VCS, and exact-ref observation until green. Discover the repository's actual gate and provider topology; never assume a branch or server separation.",
  ];
  if (computerUse) {
    instructions.push(
      "Interactive GUI, browser, and Computer Use execution is Root-only and must not be delegated.",
    );
  } else {
    instructions.push(
      "Computer Use is not selected for this installation; delegate GUI, browser, and Computer Use execution to an appropriate bounded specialist.",
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

/** Render one canonical native specialist profile as Codex TOML. */
export function renderNativeAgent(agent: NativeAgentProjection): string {
  const shared = agent.rolePolicy;
  const instructions = [
    surgicalMutationInstruction(),
    SPECIALIST_BOUNDARY_POLICY,
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
    `sandbox_mode = ${JSON.stringify(agent.permissions.write ? "workspace-write" : "read-only")}`,
    'approval_policy = "never"',
    `web_search = ${JSON.stringify(agent.permissions.network ? "live" : "disabled")}`,
    `developer_instructions = ${JSON.stringify(instructions)}`,
    "",
    "[agents]",
    "enabled = false",
    "interrupt_message = false",
    "",
    "[features]",
    "multi_agent_v2 = false",
    "multi_agent = false",
    "computer_use = false",
    "browser_use = false",
    "in_app_browser = false",
    "",
  ].join("\n");
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
  if (/^holycodex\/agents\/(?:explorer|librarian|worker|reviewer)\.toml$/u.test(relativePath)) {
    return true;
  }
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
