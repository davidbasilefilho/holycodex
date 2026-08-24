// SPDX-License-Identifier: Apache-2.0

import {
  AppServer,
  AppServerLive,
  CodexError,
  createProjectTrustIdentity,
  discoverCodexExecutable,
  executeAssignment,
  SemanticAssignmentPacketSchema,
  SemanticExecutionOutcomeSchema,
  LiveOfficialPluginListEnvelopeSchema,
  type AssignmentExecutionOptions,
  type AssignmentExecutionService,
  type CodexExecutableIdentity,
  type ProjectTrustIdentity,
  type SemanticAssignmentPacket,
  type SemanticExecutionOutcome,
} from "@holycodex/codex";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CAPABILITY_REGISTRY,
  CapabilityNameSchema,
  canonicalJson,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  lookupRoleDefinition,
  lookupPlan,
  normalizeSpecialistOutcome,
  parseCapabilityResultV2,
  RoleTaskSchema,
  RouteKeySchema,
  SPECIALIST_OUTCOME_VERSION,
  specialistOutcomeFromCapabilityResult,
  type CapabilityName,
  type CapabilityResultV2,
  type JsonObject,
  type JsonValue,
  type PlanName,
  type ServiceTier,
} from "@holycodex/core";
import {
  FileRunStore,
  buildNativeWorkflowIdentity,
  WorkflowHost,
  type WorkflowDefinition,
  type WorkflowHostOptions,
} from "@holycodex/workflow-host";
import { loadNativeWorkflowSource, type NativeWorkflow } from "@holycodex/workflow-runtime";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { resolveInstallerPaths } from "./paths.ts";
import { readActiveInstallRecord } from "./installer.ts";
import type {
  CliContext,
  InstallerOptions,
  ParsedCommand,
  WorkflowCapabilityName,
  WorkflowService,
} from "./types.ts";
import { decodeSchema, JsonObjectSchema, JsonValueSchema } from "./schema.ts";
import { asJsonValue } from "./json.ts";
import { readSavedWorkflow, saveWorkflow } from "./workflow-store.ts";
import { GeneratedWorkflowStore, GeneratedWorkflowStoreError } from "./generated-workflow-store.ts";
import { migrateLegacyState, readMigratedInstallerSelections } from "./migration.ts";
import { findRefinement, listRefinements, replaceRefinement } from "./refinement-store.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import { executeLspSetup, type ToolExecutionResult } from "@holycodex/lsp-core/tools";
import { callToolViaDaemon } from "@holycodex/lsp-daemon";
import {
  normalizeGitBashEnvironment,
  resolveGitBashForCurrentProcess,
  runGitBashCommand,
} from "@holycodex/git-bash";
import type {
  AppServerAssignmentPort,
  CapabilityStateRecord,
  OfficialPluginStatus,
  WorkflowCapabilityPort,
  WorkflowCapabilityRequest,
} from "./types.ts";

const MAX_WORKFLOW_SOURCE_BYTES = 1024 * 1024;

export interface WorkflowSource {
  readonly source: string;
  readonly args: JsonValue;
  readonly path: string | null;
}

export async function executeWorkflowCommand(
  parsed: ParsedCommand,
  context: CliContext,
): Promise<JsonValue> {
  const service = context.workflowService ?? (await createDefaultWorkflowService(context, parsed));
  switch (parsed.command) {
    case "workflow run": {
      let workflow = await readWorkflowSource(
        parsed.positionals[0] ?? "",
        parsed.positionals[1],
        parsed,
        context,
      );
      const compatibility = parsed.options["compat-quickjs"] === true;
      const nativeRequested = context.workflowService === undefined && !compatibility;
      const generatedStore =
        context.workflowService === undefined && workflow.path === null
          ? await materializeGeneratedWorkflow(workflow, context)
          : undefined;
      if (generatedStore !== undefined) workflow = generatedStore.source;
      let nativeWorkflow: NativeWorkflow | undefined;
      try {
        nativeWorkflow = nativeRequested ? await loadNativeWorkflow(workflow) : undefined;
        if (
          nativeWorkflow !== undefined &&
          generatedStore !== undefined &&
          workflow.path !== null
        ) {
          await generatedStore.store.recordNativeIdentity(
            workflow.path,
            await buildNativeWorkflowIdentity(workflow.source, nativeWorkflow, {}),
          );
        }
        const createInput: {
          source: string;
          args: JsonValue;
          objective: string;
          sourcePath?: string;
          plan?: PlanName;
          serviceTier?: ServiceTier;
          autonomy?: "manual" | "assisted" | "autonomous";
          maxSubagents?: number;
          workflow?: WorkflowDefinition;
        } = {
          source: workflow.source,
          args: workflow.args,
          ...(generatedStore === undefined || workflow.path === null
            ? {}
            : { sourcePath: workflow.path }),
          objective:
            optionString(parsed, "task") ?? defaultObjective(workflow.path, parsed.positionals[0]),
        };
        const plan = optionalPlan(parsed);
        const tier = optionalTier(parsed);
        const autonomy = optionalAutonomy(parsed);
        const maxSubagents = optionalMaxSubagents(parsed);
        if (plan !== undefined) createInput.plan = plan;
        if (tier !== undefined) createInput.serviceTier = tier;
        if (autonomy !== undefined) createInput.autonomy = autonomy;
        if (maxSubagents !== undefined) createInput.maxSubagents = maxSubagents;
        if (nativeWorkflow !== undefined) createInput.workflow = nativeWorkflow;
        const created = await requireCapability(service.create, "create")(createInput);
        const execution = await requireCapability(
          service.run,
          "run",
        )({
          runId: created.run_id,
          source: workflow.source,
          args: workflow.args,
          ...(generatedStore === undefined || workflow.path === null
            ? {}
            : { sourcePath: workflow.path }),
          ...(nativeWorkflow === undefined ? {} : { workflow: nativeWorkflow }),
          ...(compatibility ? { compatibility: true } : {}),
        });
        return asJsonValue(execution);
      } finally {
        nativeWorkflow?.dispose();
        await generatedStore?.store
          .setSessionActivity(generatedStore.sessionId, false)
          .catch(() => undefined);
      }
    }
    case "workflow list":
      return asJsonValue(await requireCapability(service.list, "list")());
    case "workflow show":
      return asJsonValue(
        await requireCapability(service.show, "show")(requiredPosition(parsed, 0, "run id")),
      );
    case "workflow inspect":
      return asJsonValue(
        await requireCapability(service.inspect, "inspect")(
          requiredPosition(parsed, 0, "run id"),
          parsed.options["follow"] === true,
        ),
      );
    case "workflow resume": {
      const runId = requiredPosition(parsed, 0, "run id");
      let workflow = await readWorkflowSource(
        requiredPosition(parsed, 1, "workflow source"),
        parsed.positionals[2],
        parsed,
        context,
      );
      await assertResumeInputIdentity(service, runId, workflow);
      const compatibility = parsed.options["compat-quickjs"] === true;
      const nativeRequested = context.workflowService === undefined && !compatibility;
      const generatedStore =
        context.workflowService === undefined && workflow.path === null
          ? await materializeGeneratedWorkflow(workflow, context)
          : undefined;
      if (generatedStore !== undefined) workflow = generatedStore.source;
      let nativeWorkflow: NativeWorkflow | undefined;
      try {
        nativeWorkflow = nativeRequested ? await loadNativeWorkflow(workflow) : undefined;
        if (
          nativeWorkflow !== undefined &&
          generatedStore !== undefined &&
          workflow.path !== null
        ) {
          await generatedStore.store.recordNativeIdentity(
            workflow.path,
            await buildNativeWorkflowIdentity(workflow.source, nativeWorkflow, {}),
          );
        }
        return asJsonValue(
          await requireCapability(
            service.resume,
            "resume",
          )({
            runId,
            source: workflow.source,
            args: workflow.args,
            ...(generatedStore === undefined || workflow.path === null
              ? {}
              : { sourcePath: workflow.path }),
            ...(nativeWorkflow === undefined ? {} : { workflow: nativeWorkflow }),
            ...(compatibility ? { compatibility: true } : {}),
          }),
        );
      } finally {
        nativeWorkflow?.dispose();
        await generatedStore?.store
          .setSessionActivity(generatedStore.sessionId, false)
          .catch(() => undefined);
      }
    }
    case "workflow continuation": {
      const runId = requiredPosition(parsed, 0, "run id");
      const workflow = await readWorkflowSource(
        requiredPosition(parsed, 1, "workflow source"),
        parsed.positionals[2],
        parsed,
        context,
      );
      return asJsonValue(
        await requireCapability(
          service.continuation,
          "continuation",
        )({
          runId,
          source: workflow.source,
          args: workflow.args,
          ...(parsed.options["compat-quickjs"] === true ? { compatibility: true } : {}),
        }),
      );
    }
    case "workflow goal":
      return asJsonValue(
        await requireCapability(service.goal, "goal")(
          requiredPosition(parsed, 0, "run id"),
          requiredPosition(parsed, 1, "goal summary"),
        ),
      );
    case "workflow pause":
      return asJsonValue(
        await requireCapability(service.pause, "pause")(requiredPosition(parsed, 0, "run id")),
      );
    case "workflow restart":
      return asJsonValue(
        await requireCapability(service.restart, "restart")(requiredPosition(parsed, 0, "run id")),
      );
    case "workflow reopen":
      return asJsonValue(
        await requireCapability(service.reopen, "reopen")(requiredPosition(parsed, 0, "run id")),
      );
    case "workflow stop":
      return asJsonValue(
        await requireCapability(service.stop, "stop")(requiredPosition(parsed, 0, "run id")),
      );
    case "workflow stop-agent":
      return asJsonValue(
        await requireCapability(service.stopAgent, "stop-agent")(
          requiredPosition(parsed, 0, "run id"),
          requiredPosition(parsed, 1, "call id"),
        ),
      );
    case "workflow save": {
      const scope = requiredScope(parsed.positionals[0]);
      const source = await readWorkflowSource(
        parsed.positionals[2] ?? "",
        undefined,
        parsed,
        context,
      );
      if (scope === "project") {
        await assertProjectTrusted(parsed, context);
      }
      return asJsonValue(
        await requireCapability(service.save, "save")(
          scope,
          requiredPosition(parsed, 1, "workflow name"),
          source.source,
        ),
      );
    }
    case "workflow invoke": {
      const args = await optionalArgs(parsed.positionals[2]);
      const scope = requiredScope(parsed.positionals[0]);
      if (scope === "project") {
        await assertProjectTrusted(parsed, context);
      }
      return asJsonValue(
        await requireCapability(service.invoke, "invoke")(
          scope,
          requiredPosition(parsed, 1, "workflow name"),
          args,
          parsed.options["compat-quickjs"] === true,
        ),
      );
    }
    case "workflow refinement list":
      return asJsonValue(await requireCapability(service.refinements?.list, "refinement list")());
    case "workflow refinement show":
      return asJsonValue(
        await requireCapability(
          service.refinements?.show,
          "refinement show",
        )(requiredPosition(parsed, 0, "refinement id")),
      );
    case "workflow refinement enable":
      return asJsonValue(
        await requireCapability(
          service.refinements?.enable,
          "refinement enable",
        )(requiredPosition(parsed, 0, "refinement id")),
      );
    case "workflow refinement disable":
      return asJsonValue(
        await requireCapability(
          service.refinements?.disable,
          "refinement disable",
        )(requiredPosition(parsed, 0, "refinement id")),
      );
    default:
      throw new WorkflowCommandError("unknown_command", "The workflow command is not supported.");
  }
}

async function assertProjectTrusted(parsed: ParsedCommand, context: CliContext): Promise<void> {
  const trusted = context.trustGate
    ? await context.trustGate(resolve(context.cwd ?? process.cwd()))
    : parsed.options["trusted"] === true;
  if (!trusted) {
    throw new WorkflowCommandError("trust_boundary_failed", "The workflow project is not trusted.");
  }
}

export async function readWorkflowSource(
  reference: string,
  argumentText: string | undefined,
  parsed: ParsedCommand,
  context: CliContext,
): Promise<WorkflowSource> {
  const args = await optionalArgs(argumentText);
  if (reference === "-") {
    if (parsed.command === "workflow run" && optionString(parsed, "task") === undefined) {
      throw new WorkflowCommandError(
        "invalid_argument",
        "Workflow stdin requires an explicit --task objective.",
      );
    }
    const source = context.readStdin ? await context.readStdin() : await readAllStdin(context);
    if (source.length === 0) {
      throw new WorkflowCommandError("invalid_argument", "Workflow stdin is empty.");
    }
    return { source: boundedWorkflowSource(source), args, path: null };
  }
  if (reference.length === 0 || extname(reference) !== ".ts") {
    throw new WorkflowCommandError(
      "invalid_argument",
      "Workflow source must be a TypeScript file or stdin.",
    );
  }
  const path = resolve(context.cwd ?? process.cwd(), reference);
  const generatedStore = new GeneratedWorkflowStore(
    resolveWorkflowInstallerPaths(context.installer, context.env).stateRoot,
    {
      ...(context.now === undefined ? {} : { now: context.now }),
      ...(context.generatedWorkflowBoundary === undefined
        ? {}
        : { boundary: context.generatedWorkflowBoundary }),
    },
  );
  if (generatedStore.ownsPath(path)) {
    try {
      const stored = await generatedStore.read(path);
      return { source: stored.source, args, path: stored.metadata.source_path };
    } catch (error: unknown) {
      if (error instanceof GeneratedWorkflowStoreError) throw error;
      throw new WorkflowCommandError(
        "invalid_argument",
        "The generated workflow source failed its integrity check.",
        error,
      );
    }
  }
  const trusted = context.trustGate
    ? await context.trustGate(path)
    : parsed.options["trusted"] === true;
  if (!trusted) {
    throw new WorkflowCommandError(
      "trust_boundary_failed",
      "The workflow project file is not trusted.",
    );
  }
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_WORKFLOW_SOURCE_BYTES) {
      throw new WorkflowCommandError("invalid_argument", "Workflow source exceeds the size limit.");
    }
    return { source: boundedWorkflowSource(await readFile(path, "utf8")), args, path };
  } catch (error: unknown) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "The workflow source could not be read.",
      error,
    );
  }
}

/** Load a file-backed native workflow through the bounded runtime source boundary. */
export async function loadNativeWorkflow(source: WorkflowSource): Promise<NativeWorkflow> {
  if (source.path === null) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "Native workflows require a trusted TypeScript file; use --compat-quickjs with stdin.",
    );
  }
  try {
    return await loadNativeWorkflowSource({ source: source.source });
  } catch (error: unknown) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "The native workflow module could not be loaded.",
      error,
    );
  }
}

async function assertResumeInputIdentity(
  service: WorkflowService,
  runId: string,
  workflow: WorkflowSource,
): Promise<void> {
  if (service.show === undefined) return;
  const projection = await service.show(runId);
  const sourceDigest = await domainSeparatedSha256("workflow-source", [
    new TextEncoder().encode(workflow.source),
  ]);
  const argsDigest = await domainSeparatedSha256("workflow-args", [
    canonicalJsonUtf8(workflow.args),
  ]);
  if (
    sourceDigest !== projection.definition.identity.workflow_source_digest ||
    argsDigest !== projection.definition.identity.resupplied_args_digest
  ) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "Resupplied workflow source or args do not match the persisted run identity.",
    );
  }
}

function defaultObjective(path: string | null, reference: string | undefined): string {
  if (path === null) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "Workflow stdin requires an explicit --task objective.",
    );
  }
  const name = basename(reference ?? "workflow.ts", extname(reference ?? "workflow.ts"));
  return `workflow:${name}`;
}

async function materializeGeneratedWorkflow(
  source: WorkflowSource,
  context: CliContext,
): Promise<
  Readonly<{
    readonly source: WorkflowSource;
    readonly store: GeneratedWorkflowStore;
    readonly sessionId: string;
  }>
> {
  const sessionId = context.workflowSessionId;
  if (sessionId === undefined) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "Generated workflow storage requires an explicit caller session identity.",
    );
  }
  const paths = resolveWorkflowInstallerPaths(context.installer, context.env);
  const store = new GeneratedWorkflowStore(paths.stateRoot, {
    ...(context.now === undefined ? {} : { now: context.now }),
    ...(context.generatedWorkflowBoundary === undefined
      ? {}
      : { boundary: context.generatedWorkflowBoundary }),
  });
  const stored = await store.put(sessionId, context.workflowName ?? "generated", source.source);
  const verified = await store.read(stored.metadata.source_path);
  return {
    store,
    sessionId,
    source: {
      ...source,
      source: verified.source,
      path: verified.metadata.source_path,
    },
  };
}

export async function optionalArgs(text: string | undefined): Promise<JsonValue> {
  if (text === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "Workflow arguments must be valid JSON.",
      error,
    );
  }
  const validated = decodeSchema(JsonValueSchema, parsed);
  if (validated === undefined) {
    throw new WorkflowCommandError("invalid_argument", "Workflow arguments must be JSON values.");
  }
  const canonical = canonicalJson(validated);
  if (new TextEncoder().encode(canonical).byteLength > 256 * 1024) {
    throw new WorkflowCommandError("invalid_argument", "Workflow arguments exceed the size limit.");
  }
  return validated;
}

export async function createDefaultWorkflowService(
  context: CliContext,
  parsed: ParsedCommand,
): Promise<WorkflowService> {
  const cwd = resolve(context.cwd ?? process.cwd());
  const installerPaths = resolveWorkflowInstallerPaths(context.installer, context.env);
  const stateRoot = installerPaths.stateRoot;
  const migration = await migrateLegacyState(installerPaths, context.now ?? (() => new Date()));
  if (migration.status === "quarantined") {
    throw new WorkflowCommandError(
      "trust_boundary_failed",
      "Legacy workflow state was retained as incompatible historical data.",
    );
  }
  const active = await readActiveInstallRecord(installerPaths);
  const migrated = await readMigratedInstallerSelections(installerPaths);
  const installedProfile = active ?? migrated;
  if (installedProfile === undefined) {
    throw new WorkflowCommandError(
      "capability_denied",
      "A validated installed profile is required before running workflows.",
      undefined,
      { reason: "installed_profile_missing", action: "Run holycodex install --yes first." },
    );
  }
  const plan = optionalPlan(parsed) ?? installedProfile.plan;
  const serviceTier = optionalTier(parsed) ?? installedProfile.tier;
  const autonomy = optionalAutonomy(parsed) ?? installedProfile.autonomy;
  const planDefinition = lookupPlan(plan);
  if (!planDefinition.ok || planDefinition.value.budget === null) {
    throw new WorkflowCommandError(
      "capability_denied",
      "The installed workflow plan does not provide specialist capacity.",
      undefined,
      { plan },
    );
  }
  const maxSubagents =
    optionalMaxSubagents(parsed) ??
    installedProfile.max_subagents ??
    planDefinition.value.budget.maxConcurrency;
  if (maxSubagents > planDefinition.value.budget.maxConcurrency) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "The effective specialist concurrency exceeds the selected plan.",
      undefined,
      { max_subagents: maxSubagents, plan: plan },
    );
  }
  let project: ProjectTrustIdentity;
  try {
    project = await createProjectTrustIdentity({
      root: cwd,
      trustEpoch: "cli",
      trustFingerprint: "cli",
    });
  } catch (error: unknown) {
    throw new WorkflowCommandError(
      "trust_boundary_failed",
      "The workflow project identity could not be established.",
      error,
    );
  }
  const digest = await domainSeparatedSha256("holycodex-cli-policy", [
    new TextEncoder().encode(cwd),
  ]);
  const nativeCommand =
    parsed.command === "workflow run" ||
    parsed.command === "workflow resume" ||
    parsed.command === "workflow invoke";
  let executable: CodexExecutableIdentity | undefined;
  if (nativeCommand && context.appServerAssignment === undefined) {
    executable = await discoverCodexExecutable({
      cwd,
      ...(context.env === undefined ? {} : { environment: context.env }),
    });
  }
  const capabilityRuntime = await createDefaultCapabilityRuntime({
    context,
    installedProfile,
    cwd,
    executable,
    nativeCommand,
  });
  const hostOptions: WorkflowHostOptions = {
    store: new FileRunStore(stateRoot),
    projectTrust: project,
    cwd,
    policyDigest: digest,
    promptProfile: "cli",
    toolProfile: "cli",
    securityProfile: "default",
    approvalPolicy: autonomy === "manual" ? "required" : "never",
    sandboxPolicy: "workspace-write",
    codexCapabilityDigest: capabilityRuntime.profileDigest,
    codex: capabilityRuntime.assignmentService,
    capacity: {
      maxConcurrency: Math.min(maxSubagents, planDefinition.value.budget.maxConcurrency),
      maxCalls: planDefinition.value.budget.maxCalls,
      costMax: planDefinition.value.budget.costMax,
    },
    refinementsEnabled: true,
  };
  const host = new WorkflowHost(hostOptions);
  return {
    create: async (input) =>
      await host.create({
        source: input.source,
        args: input.args,
        objective: input.objective,
        ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
        plan: input.plan ?? plan,
        serviceTier: input.serviceTier ?? serviceTier,
        expectedConcurrency: input.maxSubagents ?? maxSubagents,
        ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
      }),
    run: async (input) => await host.run(input),
    resume: async (input) => await host.resume(input),
    continuation: async (input) =>
      asJsonValue(
        await host.createContinuation({
          runId: input.runId,
          sessionId: input.runId,
          source: input.source,
          args: input.args,
        }),
      ),
    list: async () => await host.list(),
    show: async (runId) => await host.inspect(runId),
    inspect: async (runId) => await host.inspect(runId),
    goal: async (runId, summary) => await host.goal(runId, summary),
    pause: async (runId) => await host.pause(runId),
    restart: async (runId) => await host.restart(runId),
    reopen: async (runId) => await host.reopen(runId),
    stop: async (runId) => await host.stop(runId),
    stopAgent: async (runId, callId) => await host.stopAgent(runId, callId),
    save: async (scope, name, source) =>
      await saveWorkflow(stateRoot, scope, name, source, cwd, context.now ?? (() => new Date())),
    invoke: async (scope, name, args, useCompatibility = false) => {
      const saved = await readSavedWorkflow(stateRoot, scope, name, cwd);
      if (!useCompatibility) {
        throw new WorkflowCommandError(
          "invalid_argument",
          "Saved native workflows require a file-backed module; invoke with --compat-quickjs for stored source.",
        );
      }
      const created = await host.create({
        source: saved.source,
        args,
        objective: `workflow:${saved.name}`,
        plan,
        serviceTier,
        expectedConcurrency: maxSubagents,
      });
      return asJsonValue(await host.run({ runId: created.run_id, source: saved.source, args }));
    },
    refinements: {
      list: async () => await listRefinements(stateRoot),
      show: async (id) => await findRefinement(stateRoot, id),
      enable: async (id) => {
        const previous = await findRefinement(stateRoot, id);
        const enabled = await host.enableRefinement(previous.run_id, id);
        return await replaceRefinement(stateRoot, enabled);
      },
      disable: async (id) => {
        const previous = await findRefinement(stateRoot, id);
        const disabled = await host.disableRefinement(previous.run_id, id);
        return await replaceRefinement(stateRoot, disabled);
      },
    },
  };
}

function resolveWorkflowInstallerPaths(
  installer: InstallerOptions | undefined,
  environment: Readonly<Record<string, string | undefined>> | undefined,
) {
  const codexHome =
    installer?.paths?.codexHome ?? environment?.["CODEX_HOME"] ?? resolve(process.cwd(), ".codex");
  const marketplaceRoot =
    installer?.paths?.marketplaceRoot ??
    environment?.["HOLYCODEX_MARKETPLACE_ROOT"] ??
    resolve(process.cwd(), ".marketplace");
  return resolveInstallerPaths({ paths: { codexHome, marketplaceRoot } }, environment);
}

export async function invokeWorkflowCapability(
  capability: WorkflowCapabilityName,
  options: JsonObject,
  context: CliContext,
): Promise<JsonValue> {
  if (decodeSchema(CapabilityNameSchema, capability) === undefined) {
    throw new WorkflowCommandError("invalid_argument", "The capability name is invalid.");
  }
  const input = decodeSchema(JsonObjectSchema, options);
  if (input === undefined) {
    throw new WorkflowCommandError(
      "invalid_argument",
      `The ${capability} capability input is not a JSON object.`,
      undefined,
      { capability, input_valid: false },
    );
  }
  if (new TextEncoder().encode(canonicalJson(input)).byteLength > 256 * 1024) {
    throw new WorkflowCommandError(
      "invalid_argument",
      `The ${capability} capability input exceeds the size limit.`,
      undefined,
      { capability, input_valid: false },
    );
  }
  const request = capabilityRequestFromInput(capability, input, context);
  const port = context.capabilities?.[capability];
  if (port === undefined) {
    throw capabilityDenied(
      capability,
      "provider_not_configured",
      `Configure an explicit ${capability} provider port before invoking it.`,
    );
  }
  const result = await invokeCapabilityRequest(request, port);
  return asJsonValue(result);
}

type InstalledProfileSnapshot = Readonly<{
  readonly plan: PlanName;
  readonly tier: ServiceTier;
  readonly digest?: string | undefined;
  readonly optional_selections?:
    | Readonly<{
        readonly computer_use: boolean;
        readonly work: boolean;
        readonly web: boolean;
        readonly security: boolean;
      }>
    | undefined;
  readonly optional?:
    | Readonly<{
        readonly computer_use: boolean;
        readonly work: boolean;
        readonly web: boolean;
        readonly security: boolean;
      }>
    | undefined;
  readonly capability_state?: CapabilityStateRecord | undefined;
}>;

type CapabilityGate = Readonly<{
  readonly selected: boolean;
  readonly status: "healthy" | "disabled" | "missing" | "pending" | "uncertain";
  readonly plugin_ids: readonly string[];
  readonly plugin_statuses: Readonly<Record<string, OfficialPluginStatus>>;
  readonly reason: string;
}>;

type CapabilityRuntime = Readonly<{
  readonly providers: Readonly<Record<WorkflowCapabilityName, WorkflowCapabilityPort>>;
  readonly gates: Readonly<Record<WorkflowCapabilityName, CapabilityGate>>;
  readonly assignmentService: AssignmentExecutionService;
  readonly profileDigest: string;
}>;

async function createDefaultCapabilityRuntime(
  input: Readonly<{
    readonly context: CliContext;
    readonly installedProfile: InstalledProfileSnapshot;
    readonly cwd: string;
    readonly executable: CodexExecutableIdentity | undefined;
    readonly nativeCommand: boolean;
  }>,
): Promise<CapabilityRuntime> {
  const selections = {
    computer_use:
      input.installedProfile.optional_selections?.computer_use ??
      input.installedProfile.optional?.computer_use ??
      false,
    work:
      input.installedProfile.optional_selections?.work ??
      input.installedProfile.optional?.work ??
      false,
    web:
      input.installedProfile.optional_selections?.web ??
      input.installedProfile.optional?.web ??
      false,
    security:
      input.installedProfile.optional_selections?.security ??
      input.installedProfile.optional?.security ??
      false,
  };
  const selectedPluginIds = [
    ...new Set(
      (["computer_use", "work", "web", "security"] as const)
        .filter((name) => selections[name])
        .flatMap((name) => CAPABILITY_REGISTRY[name].pluginIds),
    ),
  ];
  const pluginStatuses = await readOfficialPluginStatuses(input.context, selectedPluginIds);
  const gates = createCapabilityGates(input.installedProfile, selections, pluginStatuses);
  const defaults = createDefaultCapabilityPorts(input.context, input.cwd, gates);
  const providers: Record<WorkflowCapabilityName, WorkflowCapabilityPort> = {
    work: input.context.capabilities?.work ?? defaults.work,
    web: input.context.capabilities?.web ?? defaults.web,
    security: input.context.capabilities?.security ?? defaults.security,
    computer_use: input.context.capabilities?.computer_use ?? defaults.computer_use,
    lsp: input.context.capabilities?.lsp ?? defaults.lsp,
    lsp_setup: input.context.capabilities?.lsp_setup ?? defaults.lsp_setup,
    git_bash: input.context.capabilities?.git_bash ?? defaults.git_bash,
  };
  const profileDigest = await domainSeparatedSha256("holycodex-capability-profile", [
    canonicalJsonUtf8({
      install_digest: input.installedProfile.digest ?? "missing",
      capability_state: input.installedProfile.capability_state ?? null,
      plugin_statuses: pluginStatuses,
      selected: selections,
      definitions: Object.fromEntries(
        (Object.keys(selections) as Array<keyof typeof selections>).map((name) => [
          name,
          {
            plugin_ids: CAPABILITY_REGISTRY[name].pluginIds,
            semantic_skill_ids: CAPABILITY_REGISTRY[name].semanticSkillIds,
          },
        ]),
      ),
    }),
  ]);
  return {
    providers,
    gates,
    profileDigest,
    assignmentService: createAssignmentService({
      context: input.context,
      cwd: input.cwd,
      executable: input.executable,
      nativeCommand: input.nativeCommand,
      providers,
      gates,
    }),
  };
}

async function readOfficialPluginStatuses(
  context: CliContext,
  selected: readonly string[],
): Promise<Readonly<Record<string, OfficialPluginStatus>>> {
  if (selected.length === 0) return {};
  const unknown = Object.fromEntries(selected.map((id) => [id, "uncertain" as const]));
  let manager = context.installer?.officialPluginManager;
  try {
    manager ??= await CodexOfficialPluginManager.discover();
    if (manager.status !== undefined) {
      const raw = await manager.status(selected);
      const schema = Schema.Record({
        key: Schema.String,
        value: Schema.Literal(
          "installed",
          "available",
          "missing",
          "disabled",
          "uncertain",
          "unknown",
        ),
      });
      return decodeSchema(schema, raw) ?? unknown;
    }
    if (manager.list === undefined) return unknown;
    const live = decodeSchema(LiveOfficialPluginListEnvelopeSchema, await manager.list());
    if (live === undefined) return unknown;
    const entries = [...live.installed, ...live.available];
    return Object.fromEntries(
      selected.map((id) => {
        const entry = entries.find((candidate) => candidate.pluginId === id);
        return [
          id,
          entry === undefined
            ? "missing"
            : entry.installed && entry.enabled
              ? "installed"
              : entry.installed
                ? "disabled"
                : "available",
        ];
      }),
    );
  } catch {
    return unknown;
  }
}

function createCapabilityGates(
  profile: InstalledProfileSnapshot,
  selections: Readonly<Record<"computer_use" | "work" | "web" | "security", boolean>>,
  pluginStatuses: Readonly<Record<string, OfficialPluginStatus>>,
): Readonly<Record<WorkflowCapabilityName, CapabilityGate>> {
  const gates: Partial<Record<WorkflowCapabilityName, CapabilityGate>> = {};
  for (const name of ["computer_use", "work", "web", "security"] as const) {
    const definition = CAPABILITY_REGISTRY[name];
    const state = profile.capability_state?.[name];
    const selected = selections[name] === true;
    const statuses: Record<string, OfficialPluginStatus> = {};
    for (const id of definition.pluginIds) statuses[id] = pluginStatuses[id] ?? "uncertain";
    const stateStatus = state?.status;
    const status: CapabilityGate["status"] = !selected
      ? "disabled"
      : stateStatus === "healthy" &&
          definition.pluginIds.every((id) => statuses[id] === "installed")
        ? "healthy"
        : stateStatus === "provider_disabled" || Object.values(statuses).includes("disabled")
          ? "disabled"
          : stateStatus === "pending"
            ? "pending"
            : stateStatus === "uncertain" ||
                Object.values(statuses).some((value) => value === "uncertain")
              ? "uncertain"
              : "missing";
    const failedPlugin = definition.pluginIds.find((id) => statuses[id] !== "installed");
    gates[name] = {
      selected,
      status,
      plugin_ids: [...definition.pluginIds],
      plugin_statuses: statuses,
      reason: !selected
        ? "capability is not selected in the installed profile"
        : failedPlugin === undefined
          ? "verified installed and enabled"
          : `plugin ${failedPlugin} is ${statuses[failedPlugin] ?? "uncertain"}`,
    };
  }
  gates.lsp = healthyLocalGate("LSP daemon adapter");
  gates.lsp_setup = healthyLocalGate("LSP setup adapter");
  gates.git_bash = healthyLocalGate("Git Bash adapter");
  return {
    computer_use: requiredGate(gates.computer_use, "computer_use"),
    work: requiredGate(gates.work, "work"),
    web: requiredGate(gates.web, "web"),
    security: requiredGate(gates.security, "security"),
    lsp: requiredGate(gates.lsp, "lsp"),
    lsp_setup: requiredGate(gates.lsp_setup, "lsp_setup"),
    git_bash: requiredGate(gates.git_bash, "git_bash"),
  };
}

function requiredGate(gate: CapabilityGate | undefined, name: string): CapabilityGate {
  if (gate === undefined) throw new Error(`Capability gate ${name} was not composed.`);
  return gate;
}

function healthyLocalGate(reason: string): CapabilityGate {
  return {
    selected: true,
    status: "healthy",
    plugin_ids: [],
    plugin_statuses: {},
    reason,
  };
}

function createDefaultCapabilityPorts(
  context: CliContext,
  cwd: string,
  gates: Readonly<Record<WorkflowCapabilityName, CapabilityGate>>,
): Record<WorkflowCapabilityName, WorkflowCapabilityPort> {
  const officialPort = (name: CapabilityName): WorkflowCapabilityPort => ({
    available: async () => gates[name].status === "healthy",
    invoke: async () => {
      throw new WorkflowCommandError(
        "capability_denied",
        `The ${name} capability must use the verified App Server semantic route.`,
        undefined,
        { capability: name, reason: "semantic_route_required" },
      );
    },
  });
  return {
    work: officialPort("work"),
    web: officialPort("web"),
    security: officialPort("security"),
    computer_use: {
      available: async () => gates.computer_use.status === "healthy",
      invoke: async (request) => {
        if (!request.rootAuthority || request.role_task !== null || request.route !== null) {
          throw new WorkflowCommandError(
            "capability_denied",
            "Computer Use requires an explicitly Root-owned operation adapter.",
            undefined,
            { capability: "computer_use", root_only: true, reason: "root_operation_required" },
          );
        }
        throw new WorkflowCommandError(
          "capability_denied",
          "Computer Use is installed but has no Root-owned operation adapter in this workflow model.",
          undefined,
          { capability: "computer_use", root_only: true, reason: "root_adapter_missing" },
        );
      },
    },
    lsp: {
      available: async () => true,
      invoke: async (request) => await executeLspCapability(request, context.env, cwd),
    },
    lsp_setup: {
      available: async () => true,
      invoke: async (request) => await executeLspSetupCapability(request),
    },
    git_bash: {
      available: async () => {
        const resolution = resolveGitBashForCurrentProcess();
        return process.platform === "win32" && resolution.found && resolution.path !== null;
      },
      invoke: async (request) => await executeGitBashCapability(request, cwd),
    },
  };
}

function createAssignmentService(
  input: Readonly<{
    readonly context: CliContext;
    readonly cwd: string;
    readonly executable: CodexExecutableIdentity | undefined;
    readonly nativeCommand: boolean;
    readonly providers: Readonly<Record<WorkflowCapabilityName, WorkflowCapabilityPort>>;
    readonly gates: Readonly<Record<WorkflowCapabilityName, CapabilityGate>>;
  }>,
): AssignmentExecutionService {
  return {
    execute: (inputValue: unknown, options: AssignmentExecutionOptions = {}) =>
      Effect.tryPromise({
        try: async (signal) => {
          const packet = decodeSchema(SemanticAssignmentPacketSchema, inputValue);
          if (packet === undefined) {
            throw new WorkflowCommandError(
              "capability_denied",
              "The semantic assignment packet is invalid at the CLI composition boundary.",
            );
          }
          return await executeComposedAssignment(
            packet,
            input.context,
            input.cwd,
            input.executable,
            input.nativeCommand,
            input.providers,
            input.gates,
            options,
            signal,
          );
        },
        catch: (error) =>
          error instanceof WorkflowCommandError
            ? new CodexError("capability_unavailable", error.message, error.details)
            : error instanceof CodexError
              ? error
              : new CodexError(
                  "execution_failed",
                  error instanceof Error ? error.message : "The capability assignment failed.",
                  {},
                  { cause: error },
                ),
      }),
  };
}

async function executeComposedAssignment(
  packet: SemanticAssignmentPacket,
  context: CliContext,
  cwd: string,
  executable: CodexExecutableIdentity | undefined,
  nativeCommand: boolean,
  providers: Readonly<Record<WorkflowCapabilityName, WorkflowCapabilityPort>>,
  gates: Readonly<Record<WorkflowCapabilityName, CapabilityGate>>,
  options: AssignmentExecutionOptions,
  signal: AbortSignal,
): Promise<SemanticExecutionOutcome> {
  const capability = packet.assignment.capability;
  if (capability === "computer_use") {
    throw new CodexError(
      "route_incompatible",
      "Computer Use is Root-only and cannot enter a specialist assignment.",
      { capability, root_only: true, needs_root_decision: true },
    );
  }
  if (capability === "work" || capability === "web" || capability === "security") {
    assertCapabilityGate(capability, gates[capability]);
    const augmented = augmentSemanticPacket(packet);
    return await runAppServerAssignment(
      augmented,
      context,
      cwd,
      executable,
      nativeCommand,
      options,
      signal,
    );
  }
  if (capability === "lsp" || capability === "lsp_setup" || capability === "git_bash") {
    const request = capabilityRequestFromPacket(packet, signal);
    const result = await invokeCapabilityRequest(request, providers[capability], gates[capability]);
    return capabilityResultToSemanticExecution(result, packet, capability);
  }
  return await runAppServerAssignment(
    packet,
    context,
    cwd,
    executable,
    nativeCommand,
    options,
    signal,
  );
}

async function runAppServerAssignment(
  packet: SemanticAssignmentPacket,
  context: CliContext,
  cwd: string,
  executable: CodexExecutableIdentity | undefined,
  nativeCommand: boolean,
  options: AssignmentExecutionOptions,
  signal: AbortSignal,
): Promise<SemanticExecutionOutcome> {
  let raw: unknown;
  const testAdapter: AppServerAssignmentPort | undefined = context.appServerAssignment;
  if (testAdapter !== undefined) {
    raw = await testAdapter.execute(packet, { signal, ...options });
  } else {
    if (!nativeCommand || executable === undefined) {
      throw new CodexError(
        "capability_unavailable",
        "The Codex App Server assignment adapter is unavailable for this operation.",
      );
    }
    raw = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const appServer = yield* AppServer;
          return yield* executeAssignment(appServer.client, packet, options);
        }).pipe(
          Effect.provide(
            AppServerLive({
              executable,
              cwd,
              ...(context.env === undefined ? {} : { environment: context.env }),
              signal,
            }),
          ),
        ),
      ),
    );
  }
  const result = decodeSchema(SemanticExecutionOutcomeSchema, raw);
  if (result === undefined || result.assignment_id !== packet.assignment.id) {
    throw new CodexError(
      "route_incompatible",
      "The App Server assignment result failed semantic identity validation.",
      { route: packet.route.key, assignment_id: packet.assignment.id },
    );
  }
  const normalized = normalizeSpecialistOutcome(result.outcome, packet.route.role_task);
  if (!normalized.ok) {
    throw new CodexError(
      "execution_failed",
      "The App Server assignment returned an invalid V2 specialist outcome.",
      { route: packet.route.key },
    );
  }
  return result;
}

function augmentSemanticPacket(packet: SemanticAssignmentPacket): SemanticAssignmentPacket {
  const capability = packet.assignment.capability;
  if (capability !== "work" && capability !== "web" && capability !== "security") {
    return packet;
  }
  const references = stableUnique([
    ...packet.assignment.references,
    ...selectSemanticSkillReferences(capability, packet.assignment.objective),
  ]);
  return {
    ...packet,
    assignment: { ...packet.assignment, references },
  };
}

function selectSemanticSkillReferences(
  capability: "work" | "web" | "security",
  objective: string,
): readonly string[] {
  const all = CAPABILITY_REGISTRY[capability].semanticSkillIds;
  if (capability !== "work") return all;
  const lower = objective.toLowerCase();
  const selected = all.filter((reference) => {
    if (reference.startsWith("documents:"))
      return /\b(doc|document|word|write|report)\b/u.test(lower);
    if (reference.startsWith("pdf:")) return /\b(pdf|acrobat|portable document)\b/u.test(lower);
    if (reference.startsWith("presentations:"))
      return /\b(slide|slides|presentation|deck|powerpoint)\b/u.test(lower);
    if (reference.startsWith("spreadsheets:"))
      return /\b(spreadsheet|excel|csv|table|sheet)\b/u.test(lower);
    if (reference.startsWith("template-creator:")) return /\b(template|boilerplate)\b/u.test(lower);
    return false;
  });
  return selected.length === 0 ? all : selected;
}

function capabilityRequestFromPacket(
  packet: SemanticAssignmentPacket,
  signal: AbortSignal,
): WorkflowCapabilityRequest {
  const capability = packet.assignment.capability;
  if (capability === undefined) {
    throw new CodexError("route_incompatible", "A host capability request has no capability name.");
  }
  return {
    capability,
    input: packet.capability_input ?? { objective: packet.assignment.objective },
    objective: packet.assignment.objective,
    role_task: packet.assignment.role_task,
    authority: packet.assignment.authority,
    scope: packet.assignment.scope,
    constraints: packet.assignment.constraints,
    required_evidence: packet.assignment.required_evidence,
    completion: packet.assignment.acceptance,
    tools: packet.tools,
    security: packet.security,
    route: packet.route.key,
    signal,
    rootAuthority: false,
  };
}

function capabilityRequestFromInput(
  capability: WorkflowCapabilityName,
  input: JsonObject,
  context: CliContext,
): WorkflowCapabilityRequest {
  if (capability === "computer_use") {
    if (context.rootAuthority !== true) {
      throw capabilityDenied(capability, "root_only", "Computer Use requires Root authority.");
    }
    return {
      capability,
      input,
      objective: textInput(input, "objective") ?? "Root-owned Computer Use operation",
      role_task: null,
      authority: "Root-only approved operation authority.",
      scope: textList(input["scope"]),
      constraints: textList(input["constraints"]),
      required_evidence: textList(input["required_evidence"]),
      completion: textList(input["completion"]),
      tools: { allowed: [], specialist_spawn: false, workflow: false },
      security: { network: false, specialist_spawn: false, workflow: false },
      route: null,
      signal: new AbortController().signal,
      rootAuthority: true,
    };
  }
  const roleTask = decodeSchema(RoleTaskSchema, {
    role: input["role"] ?? "Worker",
    task: input["task"] ?? "implementation",
  });
  if (roleTask === undefined) {
    throw new WorkflowCommandError("invalid_argument", "The capability role/task is invalid.");
  }
  const role = lookupRoleDefinition(roleTask.role);
  const route = decodeSchema(RouteKeySchema, input["route"] ?? `${roleTask.role}:${roleTask.task}`);
  if (route === undefined || route !== `${roleTask.role}:${roleTask.task}`) {
    throw new WorkflowCommandError("invalid_argument", "The capability route is invalid.");
  }
  return {
    capability,
    input,
    objective: textInput(input, "objective") ?? `Execute ${capability} capability`,
    role_task: roleTask,
    authority: role.authority,
    scope: textList(input["scope"] ?? input["files"]),
    constraints: textList(input["constraints"]),
    required_evidence: textList(input["required_evidence"]),
    completion: textList(input["completion"]),
    tools: {
      allowed: [
        "read",
        ...(role.permissions.write ? ["write"] : []),
        ...(role.permissions.execute ? ["execute"] : []),
        ...(role.permissions.network ? ["network"] : []),
      ],
      specialist_spawn: false,
      workflow: false,
    },
    security: {
      network: role.permissions.network,
      specialist_spawn: false,
      workflow: false,
    },
    route,
    signal: new AbortController().signal,
    rootAuthority: context.rootAuthority === true,
  };
}

async function invokeCapabilityRequest(
  request: WorkflowCapabilityRequest,
  port: WorkflowCapabilityPort,
  gate?: CapabilityGate,
): Promise<CapabilityResultV2> {
  validateCapabilityRequest(request);
  if (gate !== undefined && gate.status !== "healthy") {
    throw capabilityDenied(
      request.capability,
      `provider_${gate.status}`,
      `The ${request.capability} provider is ${gate.status}: ${gate.reason}.`,
      {
        plugin_ids: gate.plugin_ids,
        plugin_statuses: gate.plugin_statuses,
        recovery: recoveryForGate(request.capability, gate),
      },
    );
  }
  if (port.available !== undefined) {
    let available = false;
    try {
      available = await port.available();
    } catch (error: unknown) {
      throw capabilityDenied(
        request.capability,
        "availability_check_failed",
        `The ${request.capability} provider availability check failed.`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (!available) {
      throw capabilityDenied(
        request.capability,
        "provider_unavailable",
        `The ${request.capability} provider is unavailable.`,
        { recovery: recoveryForUnavailable(request.capability) },
      );
    }
  }
  let raw: unknown;
  try {
    raw = await port.invoke(request);
  } catch (error: unknown) {
    if (error instanceof WorkflowCommandError) throw error;
    throw capabilityDenied(
      request.capability,
      "provider_invocation_failed",
      `The ${request.capability} provider invocation failed closed.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const parsed = parseCapabilityResultV2(raw);
  if (!parsed.ok || parsed.value.capability !== request.capability) {
    throw capabilityDenied(
      request.capability,
      "invalid_provider_outcome",
      `The ${request.capability} provider returned an invalid V2 capability result.`,
      { output_valid: false },
    );
  }
  if (
    (request.route === null && parsed.value.route !== null) ||
    (request.route !== null &&
      (parsed.value.route === null ||
        parsed.value.route.role !== request.role_task?.role ||
        parsed.value.route.task !== request.role_task?.task))
  ) {
    throw capabilityDenied(
      request.capability,
      "provider_route_tamper",
      `The ${request.capability} provider returned a result for a different route.`,
      { output_valid: false, route: request.route },
    );
  }
  return parsed.value;
}

function validateCapabilityRequest(request: WorkflowCapabilityRequest): void {
  if (decodeSchema(CapabilityNameSchema, request.capability) === undefined) {
    throw new WorkflowCommandError("invalid_argument", "The capability request name is invalid.");
  }
  if (request.role_task === null || request.route === null) {
    if (request.capability !== "computer_use" || !request.rootAuthority) {
      throw capabilityDenied(
        request.capability,
        "root_only",
        "Only Root may issue a route-less capability request.",
      );
    }
    return;
  }
  const role = lookupRoleDefinition(request.role_task.role);
  if (
    request.route !== `${request.role_task.role}:${request.role_task.task}` ||
    request.authority !== role.authority
  ) {
    throw capabilityDenied(
      request.capability,
      "authority_mismatch",
      "The capability request authority or route is invalid.",
    );
  }
  const allowed = [
    "read",
    ...(role.permissions.write ? ["write"] : []),
    ...(role.permissions.execute ? ["execute"] : []),
    ...(role.permissions.network ? ["network"] : []),
  ];
  if (
    request.tools.allowed.some((tool) => !allowed.includes(tool)) ||
    (request.security.network && !role.permissions.network) ||
    request.tools.specialist_spawn ||
    request.tools.workflow ||
    request.security.specialist_spawn ||
    request.security.workflow
  ) {
    throw capabilityDenied(
      request.capability,
      "authority_mismatch",
      "The capability request exceeds role authority.",
    );
  }
}

function capabilityResultToSemanticExecution(
  result: CapabilityResultV2,
  packet: SemanticAssignmentPacket,
  capability: WorkflowCapabilityName,
): SemanticExecutionOutcome {
  const normalized = specialistOutcomeFromCapabilityResult(
    result,
    capability,
    packet.route.role_task,
  );
  if (!normalized.ok) {
    throw new CodexError(
      "route_incompatible",
      "The host capability result could not be normalized to the assignment route.",
      { capability, route: packet.route.key },
    );
  }
  return {
    assignment_id: packet.assignment.id,
    route_key: packet.route.key,
    thread_id: `capability-${capability}`,
    turn_id: `capability-${capability}`,
    backend: "host-capability",
    outcome: normalized.value,
  };
}

function capabilityDenied(
  capability: WorkflowCapabilityName,
  reason: string,
  message: string,
  details: JsonObject = {},
): WorkflowCommandError {
  return new WorkflowCommandError("capability_denied", message, undefined, {
    capability,
    reason,
    available: false,
    ...details,
  });
}

function assertCapabilityGate(capability: WorkflowCapabilityName, gate: CapabilityGate): void {
  if (gate.status === "healthy") return;
  throw new CodexError(
    "capability_unavailable",
    `The ${capability} capability is denied before the specialist effect: ${gate.reason}.`,
    {
      capability,
      provider_status: gate.status,
      plugin_ids: gate.plugin_ids,
      plugin_statuses: gate.plugin_statuses,
      recovery: recoveryForGate(capability, gate),
    },
  );
}

function recoveryForGate(capability: WorkflowCapabilityName, gate: CapabilityGate): string {
  if (gate.status === "disabled") return `Enable the verified ${capability} plugin(s), then retry.`;
  if (gate.status === "pending" || gate.status === "uncertain")
    return "Retry installation to converge provider state, then retry.";
  return `Select and install the ${capability} capability, then retry.`;
}

function recoveryForUnavailable(capability: WorkflowCapabilityName): string {
  if (capability === "git_bash")
    return "Run on Windows with verified Git Bash available in an allowed path.";
  if (capability === "lsp" || capability === "lsp_setup")
    return "Configure a local LSP server explicitly, then retry.";
  return `Configure a verified ${capability} provider and retry.`;
}

function textInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function textList(value: JsonValue | undefined): readonly string[] {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function extractCapabilityParams(input: JsonObject): JsonObject {
  const nested = input["params"] ?? input["arguments"];
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return decodeSchema(JsonObjectSchema, nested) ?? {};
  }
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        ![
          "capability",
          "role",
          "task",
          "route",
          "objective",
          "scope",
          "constraints",
          "required_evidence",
          "completion",
          "params",
          "arguments",
        ].includes(key),
    ),
  );
}

async function executeLspCapability(
  request: WorkflowCapabilityRequest,
  environment: Readonly<Record<string, string | undefined>> | undefined,
  cwd: string,
): Promise<CapabilityResultV2> {
  const name =
    textInput(request.input, "tool") ??
    textInput(request.input, "operation") ??
    textInput(request.input, "name");
  if (name === undefined) {
    throw capabilityDenied("lsp", "invalid_input", "LSP requires a validated tool name.");
  }
  const timeoutMs = boundedTimeout(request.input["timeoutMs"]);
  const params = extractCapabilityParams(request.input);
  const result = await callToolViaDaemon(name, params, {
    context: { cwd, env: filteredLspEnvironment(environment) },
    requestTimeoutMs: timeoutMs,
    signal: request.signal,
  });
  return capabilityResultFromTool(request, result, `LSP ${name} completed.`);
}

async function executeLspSetupCapability(
  request: WorkflowCapabilityRequest,
): Promise<CapabilityResultV2> {
  const result = await executeLspSetup({ ...extractCapabilityParams(request.input) });
  return capabilityResultFromTool(
    request,
    result,
    "LSP setup completed or returned a setup diagnostic.",
  );
}

function capabilityResultFromTool(
  request: WorkflowCapabilityRequest,
  result: ToolExecutionResult,
  summary: string,
): CapabilityResultV2 {
  const details = decodeSchema(JsonValueSchema, result.details);
  const data: JsonObject = {
    content: result.content.map((item) => ({ type: item.type, text: item.text })),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(details === undefined ? {} : { details }),
  };
  return {
    protocol_version: SPECIALIST_OUTCOME_VERSION,
    capability: request.capability,
    route: request.role_task,
    evidence: result.content.map((item) => item.text).filter((text) => text.length > 0),
    data,
    status: "completed",
    summary,
  };
}

async function executeGitBashCapability(
  request: WorkflowCapabilityRequest,
  projectRoot: string,
): Promise<CapabilityResultV2> {
  if (!request.tools.allowed.includes("execute")) {
    throw capabilityDenied(
      "git_bash",
      "authority_mismatch",
      "Git Bash requires execute permission for the assigned role.",
    );
  }
  const command = textInput(request.input, "command");
  if (command === undefined)
    throw capabilityDenied("git_bash", "invalid_input", "Git Bash requires a command.");
  const resolution = resolveGitBashForCurrentProcess();
  if (process.platform !== "win32" || !resolution.found || resolution.path === null) {
    throw capabilityDenied(
      "git_bash",
      "git_bash_unavailable",
      "Git Bash is unavailable on this platform or could not be verified.",
      { checked_paths: resolution.checkedPaths, recovery: recoveryForUnavailable("git_bash") },
    );
  }
  const requestedCwd = textInput(request.input, "cwd") ?? projectRoot;
  const effectiveCwd = resolve(requestedCwd);
  const root = resolve(projectRoot);
  const relativePath = relative(root, effectiveCwd);
  if (relativePath.startsWith("..") || relativePath.includes("\u0000")) {
    throw capabilityDenied(
      "git_bash",
      "scope_denied",
      "Git Bash cwd must remain within the assigned project scope.",
    );
  }
  const envValue = request.input["env"];
  const env: NodeJS.ProcessEnv | undefined =
    envValue === undefined
      ? undefined
      : typeof envValue === "object" && envValue !== null && !Array.isArray(envValue)
        ? Object.fromEntries(
            Object.entries(envValue).map(([key, value]) => {
              if (typeof value !== "string")
                throw new WorkflowCommandError(
                  "invalid_argument",
                  "Git Bash environment values must be strings.",
                );
              return [key, value];
            }),
          )
        : (() => {
            throw new WorkflowCommandError(
              "invalid_argument",
              "Git Bash environment must be an object.",
            );
          })();
  if (env !== undefined) normalizeGitBashEnvironment(env);
  const result = await runGitBashCommand({
    bashPath: resolution.path,
    command,
    cwd: effectiveCwd,
    timeoutMs: boundedTimeout(request.input["timeoutMs"]),
    maxOutputChars: boundedOutput(request.input["maxOutputChars"]),
    ...(env === undefined ? {} : { env }),
    signal: request.signal,
  });
  const data: JsonObject = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
    ...(result.outputTruncated === undefined ? {} : { outputTruncated: result.outputTruncated }),
  };
  if (result.timedOut || result.aborted === true) {
    return {
      protocol_version: SPECIALIST_OUTCOME_VERSION,
      capability: "git_bash",
      route: request.role_task,
      evidence: [result.timedOut ? "Git Bash command timed out." : "Git Bash command was aborted."],
      data,
      status: "failed",
      error: result.timedOut ? "Git Bash command timed out." : "Git Bash command was aborted.",
    };
  }
  return {
    protocol_version: SPECIALIST_OUTCOME_VERSION,
    capability: "git_bash",
    route: request.role_task,
    evidence: ["Git Bash command completed within the assigned scope."],
    data,
    status: "completed",
    summary: "Git Bash command completed.",
  };
}

function filteredLspEnvironment(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const keys = [
    "HOLYCODEX_LSP_PROJECT_CONFIG",
    "HOLYCODEX_LSP_USER_CONFIG",
    "HOLYCODEX_LSP_INSTALL_DECISIONS",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = environment?.[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function boundedTimeout(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 120_000
    ? value
    : 30_000;
}

function boundedOutput(value: JsonValue | undefined): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 1024 * 1024
    ? value
    : 256 * 1024;
}

function optionalPlan(parsed: ParsedCommand): PlanName | undefined {
  const value = parsed.options["plan"];
  if (typeof value !== "string") {
    return undefined;
  }
  const result = lookupPlan(value);
  if (!result.ok) {
    throw new WorkflowCommandError("invalid_argument", "The workflow plan is not supported.");
  }
  return result.value.name;
}

function optionalTier(parsed: ParsedCommand): ServiceTier | undefined {
  const value = parsed.options["tier"];
  if (typeof value === "string" && (value === "Standard" || value === "Fast")) {
    return value;
  }
  return parsed.options["fast"] === true ? "Fast" : undefined;
}

function optionalAutonomy(parsed: ParsedCommand): "manual" | "assisted" | "autonomous" | undefined {
  const value = parsed.options["autonomy"];
  return value === "manual" || value === "assisted" || value === "autonomous" ? value : undefined;
}

function optionalMaxSubagents(parsed: ParsedCommand): number | undefined {
  const value = parsed.options["max-subagents"];
  if (typeof value !== "string") return undefined;
  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : undefined;
}

function optionString(parsed: ParsedCommand, key: string): string | undefined {
  const value = parsed.options[key];
  return typeof value === "string" ? value : undefined;
}

function requiredPosition(parsed: ParsedCommand, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (!value) {
    throw new WorkflowCommandError("invalid_argument", `The ${label} is required.`);
  }
  return value;
}

function requiredScope(value: string | undefined): "user" | "project" {
  if (value !== "user" && value !== "project") {
    throw new WorkflowCommandError("invalid_argument", "Workflow scope must be user or project.");
  }
  return value;
}

function requireCapability<T extends (...args: never[]) => unknown>(
  capability: T | undefined,
  name: string,
): T {
  if (!capability) {
    throw new WorkflowCommandError(
      "unsupported",
      `The workflow capability ${name} is unsupported.`,
    );
  }
  return capability;
}

async function readAllStdin(context: CliContext): Promise<string> {
  const chunks: string[] = [];
  let byteLength = 0;
  for await (const chunk of context.io?.stdin ?? []) {
    byteLength += new TextEncoder().encode(chunk).byteLength;
    if (byteLength > MAX_WORKFLOW_SOURCE_BYTES) {
      throw new WorkflowCommandError("invalid_argument", "Workflow source exceeds the size limit.");
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}

function boundedWorkflowSource(source: string): string {
  if (new TextEncoder().encode(source).byteLength > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new WorkflowCommandError("invalid_argument", "Workflow source exceeds the size limit.");
  }
  return source;
}

export class WorkflowCommandError extends Error {
  readonly code:
    | "invalid_argument"
    | "trust_boundary_failed"
    | "unsupported"
    | "unknown_command"
    | "capability_denied";
  readonly causeValue: unknown;
  readonly details: JsonObject;

  constructor(
    code:
      | "invalid_argument"
      | "trust_boundary_failed"
      | "unsupported"
      | "unknown_command"
      | "capability_denied",
    message: string,
    causeValue?: unknown,
    details: JsonObject = {},
  ) {
    super(message);
    this.name = "WorkflowCommandError";
    this.code = code;
    this.causeValue = causeValue;
    this.details = details;
  }
}
