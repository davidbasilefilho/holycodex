// SPDX-License-Identifier: Apache-2.0

import {
  AppServer,
  AppServerLive,
  AgentExecutionLive,
  createProjectTrustIdentity,
  discoverCodexExecutable,
  executeAssignment,
  type ProjectTrustIdentity,
  type SemanticAssignmentPacket,
} from "@holycodex/codex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  canonicalJson,
  domainSeparatedSha256,
  lookupPlan,
  RoleTaskSchema,
  SpecialistOutcomeSchema,
  type JsonObject,
  type JsonValue,
  type PlanName,
  type ServiceTier,
} from "@holycodex/core";
import {
  FileRunStore,
  WorkflowHost,
  type WorkflowDefinition,
  type WorkflowHostOptions,
} from "@holycodex/workflow-host";
import { Wait } from "@holycodex/workflow-runtime";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
import { migrateLegacyState, readMigratedInstallerSelections } from "./migration.ts";
import { findRefinement, listRefinements, replaceRefinement } from "./refinement-store.ts";

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
      const workflow = await readWorkflowSource(
        parsed.positionals[0] ?? "",
        parsed.positionals[1],
        parsed,
        context,
      );
      const compatibility = parsed.options["compat-quickjs"] === true;
      const nativeRequested = context.workflowService === undefined && !compatibility;
      const nativeWorkflow = nativeRequested ? await loadNativeWorkflow(workflow) : undefined;
      const createInput: {
        source: string;
        args: JsonValue;
        objective: string;
        plan?: PlanName;
        serviceTier?: ServiceTier;
        autonomy?: "manual" | "assisted" | "autonomous";
        maxSubagents?: number;
        workflow?: WorkflowDefinition;
      } = {
        source: workflow.source,
        args: workflow.args,
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
        ...(nativeWorkflow === undefined ? {} : { workflow: nativeWorkflow }),
        ...(compatibility ? { compatibility: true } : {}),
      });
      return asJsonValue(execution);
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
      const workflow = await readWorkflowSource(
        requiredPosition(parsed, 1, "workflow source"),
        parsed.positionals[2],
        parsed,
        context,
      );
      const compatibility = parsed.options["compat-quickjs"] === true;
      const nativeRequested = context.workflowService === undefined && !compatibility;
      const nativeWorkflow = nativeRequested ? await loadNativeWorkflow(workflow) : undefined;
      return asJsonValue(
        await requireCapability(
          service.resume,
          "resume",
        )({
          runId,
          source: workflow.source,
          args: workflow.args,
          ...(nativeWorkflow === undefined ? {} : { workflow: nativeWorkflow }),
          ...(compatibility ? { compatibility: true } : {}),
        }),
      );
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

async function loadNativeWorkflow(source: WorkflowSource): Promise<WorkflowDefinition> {
  if (source.path === null) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "Native workflows require a trusted TypeScript file; use --compat-quickjs with stdin.",
    );
  }
  let loaded: unknown;
  try {
    loaded = await import(`${pathToFileURL(source.path).href}?holycodex=${Date.now()}`);
  } catch (error: unknown) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "The native workflow module could not be loaded.",
      error,
    );
  }
  if (typeof loaded !== "object" || loaded === null) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "The native workflow module must export a default workflow.wait(...) value.",
    );
  }
  const candidate =
    "default" in loaded ? loaded.default : "workflow" in loaded ? loaded.workflow : undefined;
  if (!(candidate instanceof Wait)) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "The native workflow module must export a default workflow.wait(...) value.",
    );
  }
  return candidate;
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

async function createDefaultWorkflowService(
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
  const compatibility = parsed.options["compat-quickjs"] === true;
  let codexLayer: WorkflowHostOptions["codexLayer"];
  if (nativeCommand && !compatibility) {
    const executable = await discoverCodexExecutable({
      cwd,
      ...(context.env === undefined ? {} : { environment: context.env }),
    });
    const appServerLayer = AppServerLive({
      executable,
      cwd,
      ...(context.env === undefined ? {} : { environment: context.env }),
    });
    codexLayer = AgentExecutionLive.pipe(Layer.provide(appServerLayer));
  }
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
    codexCapabilityDigest: digest,
    executeSpecialist: (assignment) => executeCodexSpecialist(assignment, context),
    ...(codexLayer === undefined ? {} : { codexLayer }),
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

async function executeCodexSpecialist(
  assignment: import("@holycodex/workflow-host").SpecialistAssignment,
  context: CliContext,
): Promise<unknown> {
  const capability = assignment.options["capability"];
  if (
    capability === "work" ||
    capability === "web" ||
    capability === "security" ||
    capability === "computer_use" ||
    capability === "lsp" ||
    capability === "lsp_setup" ||
    capability === "git_bash"
  ) {
    return await invokeWorkflowCapability(capability, assignment.options, context);
  }
  const executable = await discoverCodexExecutable({
    cwd: context.cwd ?? process.cwd(),
    ...(context.env === undefined ? {} : { environment: context.env }),
  });
  const roleTask = decodeSchema(RoleTaskSchema, {
    role: assignment.role,
    task: assignment.task,
  });
  if (roleTask === undefined) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "The workflow specialist route has an unsupported role and task combination.",
    );
  }
  const packet: SemanticAssignmentPacket = {
    assignment: {
      id: `${assignment.runId}:${assignment.route}`,
      objective: assignment.prompt,
      role_task: roleTask,
    },
    context: assignment.options,
    route: { key: assignment.route, role_task: roleTask },
    tools: { allowed: [], specialist_spawn: false, workflow: false },
    security: { network: false, specialist_spawn: false, workflow: false },
    compatibility: {
      model: "Luna",
      effort:
        assignment.plan.routes.find((route) => route.key === assignment.route)?.effort ?? "medium",
      service_tier: assignment.serviceTier,
      prefer_multi_agent_v2: true,
      require_multi_agent_v2: false,
    },
  };
  const effect = Effect.scoped(
    Effect.gen(function* () {
      const appServer = yield* AppServer;
      const execution = yield* executeAssignment(appServer.client, packet);
      return execution.outcome;
    }).pipe(
      Effect.provide(
        AppServerLive({
          executable,
          cwd: context.cwd ?? process.cwd(),
          ...(context.env === undefined ? {} : { environment: context.env }),
          signal: assignment.signal,
        }),
      ),
    ),
  );
  return await Effect.runPromise(effect);
}

export async function invokeWorkflowCapability(
  capability: WorkflowCapabilityName,
  options: JsonObject,
  context: CliContext,
): Promise<JsonValue> {
  if (capability === "computer_use" && context.rootAuthority !== true) {
    throw new WorkflowCommandError(
      "capability_denied",
      "Computer Use is a Root-only capability.",
      undefined,
      { capability, root_only: true },
    );
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
  const port = context.capabilities?.[capability];
  if (!port) {
    throw new WorkflowCommandError(
      "capability_denied",
      `The ${capability} capability is unavailable.`,
      undefined,
      {
        capability,
        available: false,
        reason: "provider_not_configured",
        action: `Configure an explicit ${capability} provider port before invoking it.`,
      },
    );
  }
  if (port.available !== undefined) {
    let available: boolean;
    try {
      available = await port.available();
    } catch (error: unknown) {
      throw new WorkflowCommandError(
        "capability_denied",
        `The ${capability} provider availability check failed.`,
        error,
        { capability, available: false, reason: "availability_check_failed" },
      );
    }
    if (available !== true) {
      throw new WorkflowCommandError(
        "capability_denied",
        `The ${capability} provider is unavailable.`,
        undefined,
        {
          capability,
          available: false,
          reason: "provider_unavailable",
          action: `Make the ${capability} provider available and retry.`,
        },
      );
    }
  }
  let rawResult: unknown;
  try {
    rawResult = await port.invoke(input);
  } catch (error: unknown) {
    throw new WorkflowCommandError(
      "capability_denied",
      `The ${capability} provider invocation failed closed.`,
      error,
      { capability, available: false, reason: "provider_invocation_failed" },
    );
  }
  const result = decodeSchema(SpecialistOutcomeSchema, rawResult);
  if (result === undefined) {
    throw new WorkflowCommandError(
      "capability_denied",
      `The ${capability} capability returned an invalid specialist outcome.`,
      undefined,
      { capability, output_valid: false, reason: "invalid_provider_outcome" },
    );
  }
  return asJsonValue(result);
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
