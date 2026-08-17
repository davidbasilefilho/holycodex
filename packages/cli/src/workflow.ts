// SPDX-License-Identifier: Apache-2.0

import { createProjectTrustIdentity, type ProjectTrustIdentity } from "@holycodex/codex";
import {
  canonicalJson,
  domainSeparatedSha256,
  lookupPlan,
  type JsonValue,
  type PlanName,
  type ServiceTier,
} from "@holycodex/core";
import { FileRunStore, WorkflowHost, type WorkflowHostOptions } from "@holycodex/workflow-host";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { CliContext, InstallerOptions, ParsedCommand, WorkflowService } from "./types.ts";
import { asJsonValue, isJsonValue } from "./json.ts";

export interface WorkflowSource {
  readonly source: string;
  readonly args: JsonValue;
  readonly path: string | null;
}

export async function executeWorkflowCommand(
  parsed: ParsedCommand,
  context: CliContext,
): Promise<JsonValue> {
  const service = context.workflowService ?? (await createDefaultWorkflowService(context));
  switch (parsed.command) {
    case "workflow run": {
      const workflow = await readWorkflowSource(
        parsed.positionals[0] ?? "",
        parsed.positionals[1],
        parsed,
        context,
      );
      const createInput: {
        source: string;
        args: JsonValue;
        objective: string;
        plan?: PlanName;
        serviceTier?: ServiceTier;
      } = {
        source: workflow.source,
        args: workflow.args,
        objective:
          optionString(parsed, "task") ?? defaultObjective(workflow.path, parsed.positionals[0]),
      };
      const plan = optionalPlan(parsed);
      const tier = optionalTier(parsed);
      if (plan !== undefined) createInput.plan = plan;
      if (tier !== undefined) createInput.serviceTier = tier;
      const created = await requireCapability(service.create, "create")(createInput);
      const execution = await requireCapability(
        service.run,
        "run",
      )({ runId: created.run_id, source: workflow.source, args: workflow.args });
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
      return asJsonValue(
        await requireCapability(
          service.resume,
          "resume",
        )({
          runId,
          source: workflow.source,
          args: workflow.args,
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
    return { source, args, path: null };
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
    return { source: await readFile(path, "utf8"), args, path };
  } catch (error: unknown) {
    throw new WorkflowCommandError(
      "invalid_argument",
      "The workflow source could not be read.",
      error,
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
  if (!isJsonValue(parsed)) {
    throw new WorkflowCommandError("invalid_argument", "Workflow arguments must be JSON values.");
  }
  const canonical = canonicalJson(parsed);
  if (new TextEncoder().encode(canonical).byteLength > 256 * 1024) {
    throw new WorkflowCommandError("invalid_argument", "Workflow arguments exceed the size limit.");
  }
  return parsed;
}

async function createDefaultWorkflowService(context: CliContext): Promise<WorkflowService> {
  const cwd = resolve(context.cwd ?? process.cwd());
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
  const hostOptions: WorkflowHostOptions = {
    store: new FileRunStore(resolveInstallerStateRoot(context.installer, context.env)),
    projectTrust: project,
    cwd,
    policyDigest: digest,
    promptProfile: "cli",
    toolProfile: "cli",
    securityProfile: "default",
    approvalPolicy: "never",
    sandboxPolicy: "workspace-write",
    codexCapabilityDigest: digest,
    executeSpecialist: async () => {
      throw new WorkflowCommandError(
        "capability_denied",
        "No specialist executor is configured for the CLI workflow adapter.",
      );
    },
  };
  const host = new WorkflowHost(hostOptions);
  return {
    create: async (input) => await host.create(input),
    run: async (input) => await host.run(input),
    resume: async (input) => await host.resume(input),
    list: async () => await host.list(),
    show: async (runId) => await host.inspect(runId),
    inspect: async (runId) => await host.inspect(runId),
    goal: async (runId, summary) => await host.goal(runId, summary),
    pause: async (runId) => await host.pause(runId),
    restart: async (runId) => await host.restart(runId),
    reopen: async (runId) => await host.reopen(runId),
    stop: async (runId) => await host.stop(runId),
    stopAgent: async (runId, callId) => await host.stopAgent(runId, callId),
  };
}

function resolveInstallerStateRoot(
  installer: InstallerOptions | undefined,
  environment: Readonly<Record<string, string | undefined>> | undefined,
): string {
  const codexHome =
    installer?.paths?.codexHome ?? environment?.["CODEX_HOME"] ?? resolve(process.cwd(), ".codex");
  return resolve(codexHome, "holycodex");
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
  return typeof value === "string" && (value === "Standard" || value === "Fast")
    ? value
    : undefined;
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
  let output = "";
  for await (const chunk of context.io?.stdin ?? []) {
    output += chunk;
  }
  return output;
}

export class WorkflowCommandError extends Error {
  readonly code:
    | "invalid_argument"
    | "trust_boundary_failed"
    | "unsupported"
    | "unknown_command"
    | "capability_denied";
  readonly causeValue: unknown;

  constructor(
    code:
      | "invalid_argument"
      | "trust_boundary_failed"
      | "unsupported"
      | "unknown_command"
      | "capability_denied",
    message: string,
    causeValue?: unknown,
  ) {
    super(message);
    this.name = "WorkflowCommandError";
    this.code = code;
    this.causeValue = causeValue;
  }
}
