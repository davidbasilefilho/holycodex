// SPDX-License-Identifier: Apache-2.0

import {
  CLI_SCHEMA_VERSION,
  parseCliEnvelope,
  type CliEnvelope,
  type JsonObject,
  type JsonValue,
  type PlanName,
  type ServiceTier,
} from "@holycodex/core";
import { lookupPlan } from "@holycodex/core";
import { ArgumentError, parseArgv } from "./args.ts";
import { cleanupHolyCodex, doctorHolyCodex } from "./maintenance.ts";
import { readCanonicalVersion, updateCanonicalVersion } from "./manifest.ts";
import { ManifestError } from "./manifest.ts";
import { PathBoundaryError } from "./paths.ts";
import { installHolyCodex, InstallerError, type InstallRequest } from "./installer.ts";
import { LockError } from "./lock.ts";
import { MarketplaceError } from "./marketplace.ts";
import { CleanupError } from "./maintenance.ts";
import { StorageError } from "./storage.ts";
import { OfficialPluginManagerError } from "./official-manager.ts";
import { WorkflowHostError } from "@holycodex/workflow-host";
import { CodexError } from "@holycodex/codex";
import { executeWorkflowCommand, WorkflowCommandError } from "./workflow.ts";
import { asJsonValue } from "./json.ts";
import { WorkflowStoreError } from "./workflow-store.ts";
import { RefinementStoreError } from "./refinement-store.ts";
import { helpRequested, helpText, helpTopic } from "./help.ts";
import type { Autonomy, CliContext, CommandResult, ParsedCommand } from "./types.ts";

export async function runCli(
  argv: readonly string[],
  context: CliContext = {},
): Promise<CommandResult> {
  if (helpRequested(argv) || argv[0] === "help") {
    const topic =
      argv[0] === "help"
        ? argv.slice(1).filter((value) => !value.startsWith("-"))[0]
        : helpTopic(argv);
    const command = topic === undefined ? "help" : `${topic} help`;
    return {
      envelope: successEnvelope(command, { help: helpText(topic) }),
      exitCode: 0,
    };
  }
  let parsed: ParsedCommand | undefined;
  try {
    parsed = parseArgv(argv);
    const data = await executeCommand(parsed, context);
    const envelope = successEnvelope(parsed.command, data);
    return { envelope, exitCode: successExitCode(parsed.command, data) };
  } catch (error: unknown) {
    const command = parsed?.command ?? inferCommand(argv);
    const failure = failureEnvelope(command, error);
    return { envelope: failure.envelope, exitCode: failure.exitCode };
  }
}

export async function executeCommand(
  parsed: ParsedCommand,
  context: CliContext,
): Promise<JsonValue> {
  switch (parsed.command) {
    case "install":
      return await executeInstall(parsed, context);
    case "doctor":
      return asJsonValue(await doctorHolyCodex(installerOptions(parsed, context), context.env));
    case "cleanup":
      return await executeCleanup(parsed, context);
    case "version":
      return await executeVersion(parsed);
    case "help":
      return { help: helpText(parsed.positionals[0]) };
    default:
      return await executeWorkflowCommand(parsed, context);
  }
}

async function executeInstall(parsed: ParsedCommand, context: CliContext): Promise<JsonValue> {
  const json = parsed.options["json"] === true;
  const confirmed = await confirmation(
    parsed,
    context,
    "Install HolyCodex into the selected owned scope?",
  );
  if (!confirmed) {
    throw new CliCommandError(
      "non_tty_confirmation_required",
      "Install requires --yes in non-interactive mode.",
    );
  }
  emitProgress(context, json, "install: validating target");
  if (parsed.options["official-plugin"] !== undefined) {
    const officialPlugins = optionStrings(parsed, "official-plugin");
    const plan = optionPlan(parsed, "plan");
    const tier = optionTier(parsed, "tier");
    const autonomy = optionAutonomy(parsed);
    const maxSubagents = optionMaxSubagents(parsed);
    const request: InstallRequest = {
      optional: optionalSelections(parsed),
      officialPlugins,
      ...(plan === undefined ? {} : { plan }),
      ...(tier === undefined ? {} : { tier }),
      ...(autonomy === undefined ? {} : { autonomy }),
      ...(maxSubagents === undefined ? {} : { maxSubagents }),
    };
    const result = await installHolyCodex(request, installerOptions(parsed, context), context.env);
    emitProgress(context, json, "install: activated");
    return asJsonValue(result);
  }
  const plan = optionPlan(parsed, "plan");
  const tier = optionTier(parsed, "tier");
  const autonomy = optionAutonomy(parsed);
  const maxSubagents = optionMaxSubagents(parsed);
  const request: InstallRequest = {
    optional: optionalSelections(parsed),
    ...(plan === undefined ? {} : { plan }),
    ...(tier === undefined ? {} : { tier }),
    ...(autonomy === undefined ? {} : { autonomy }),
    ...(maxSubagents === undefined ? {} : { maxSubagents }),
  };
  const result = await installHolyCodex(request, installerOptions(parsed, context), context.env);
  emitProgress(context, json, "install: activated");
  return asJsonValue(result);
}

async function executeCleanup(parsed: ParsedCommand, context: CliContext): Promise<JsonValue> {
  const yes =
    parsed.options["yes"] === true ||
    (parsed.options["json"] !== true &&
      parsed.options["no-tui"] !== true &&
      context.io?.stdoutIsTTY === true &&
      (await confirmIfAvailable(context, "Remove the selected HolyCodex-owned scope?")));
  const cleanupInput: { yes: boolean; runId?: string } = { yes };
  const runId = optionString(parsed, "run-id");
  if (runId !== undefined) cleanupInput.runId = runId;
  return asJsonValue(
    await cleanupHolyCodex(
      requiredCleanupScope(parsed),
      installerOptions(parsed, context),
      cleanupInput,
      context.env,
    ),
  );
}

async function executeVersion(parsed: ParsedCommand): Promise<JsonValue> {
  const target = parsed.positionals[0];
  if (!target) {
    return { version: await readCanonicalVersion() };
  }
  return await updateCanonicalVersion(target, parsed.options["dry-run"] === true);
}

async function confirmation(
  parsed: ParsedCommand,
  context: CliContext,
  message: string,
): Promise<boolean> {
  if (parsed.options["yes"] === true) {
    return true;
  }
  if (
    parsed.options["json"] === true ||
    parsed.options["no-tui"] === true ||
    context.io?.stdoutIsTTY !== true
  ) {
    return false;
  }
  return await confirmIfAvailable(context, message);
}

async function confirmIfAvailable(context: CliContext, message: string): Promise<boolean> {
  if (!context.io?.confirm) {
    return false;
  }
  return await context.io.confirm(message);
}

function optionalSelections(parsed: ParsedCommand):
  | Readonly<
      Partial<{
        computer_use: boolean;
        work: boolean;
        web: boolean;
        security: boolean;
      }>
    >
  | undefined {
  const result: Partial<{ computer_use: boolean; work: boolean; web: boolean; security: boolean }> =
    {};
  const pairs = [
    ["computer_use", "computer-use", "no-computer-use"],
    ["work", "work", "no-work"],
    ["web", "web", "no-web"],
    ["security", "security", "no-security"],
  ] as const;
  for (const [key, positive, negative] of pairs) {
    if (parsed.options[positive] === true) {
      result[key] = true;
    } else if (parsed.options[positive] === false) {
      result[key] = false;
    } else if (parsed.options[negative] === true) {
      result[key] = false;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function optionPlan(parsed: ParsedCommand, key: string): PlanName | undefined {
  const value = parsed.options[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const result = lookupPlan(value);
  return result.ok ? result.value.name : undefined;
}

function optionTier(parsed: ParsedCommand, key: string): ServiceTier | undefined {
  const value = parsed.options[key];
  if (value === "Standard" || value === "Fast") {
    return value;
  }
  if (parsed.options["fast"] === true) {
    return "Fast";
  }
  return undefined;
}

function optionAutonomy(parsed: ParsedCommand): Autonomy | undefined {
  const value = parsed.options["autonomy"];
  return value === "manual" || value === "assisted" || value === "autonomous" ? value : undefined;
}

function optionMaxSubagents(parsed: ParsedCommand): number | undefined {
  const value = parsed.options["max-subagents"];
  if (typeof value !== "string") {
    return undefined;
  }
  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : undefined;
}

function optionString(parsed: ParsedCommand, key: string): string | undefined {
  const value = parsed.options[key];
  return typeof value === "string" ? value : undefined;
}

function optionStrings(parsed: ParsedCommand, key: string): readonly string[] {
  const value = parsed.options[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function requiredCleanupScope(parsed: ParsedCommand): "run" | "workspace" | "expired" {
  const value = parsed.options["scope"];
  if (value === "run" || value === "workspace" || value === "expired") {
    return value;
  }
  throw new CliCommandError("invalid_argument", "Cleanup requires a valid scope.");
}

function installerOptions(parsed: ParsedCommand, context: CliContext) {
  const base = context.installer ?? {};
  const existing = base.paths ?? {};
  const codexHome = optionString(parsed, "codex-home");
  const marketplaceRoot = optionString(parsed, "marketplace-root");
  if (codexHome === undefined && marketplaceRoot === undefined) {
    return base.now === undefined && context.now !== undefined
      ? { ...base, now: context.now }
      : base;
  }
  const paths = { ...existing };
  if (codexHome !== undefined) paths.codexHome = codexHome;
  if (marketplaceRoot !== undefined) paths.marketplaceRoot = marketplaceRoot;
  return {
    ...base,
    paths,
    ...(base.now === undefined && context.now !== undefined ? { now: context.now } : {}),
  };
}

function successEnvelope(command: string, data: JsonValue): CliEnvelope {
  const candidate = { schema_version: CLI_SCHEMA_VERSION, ok: true, command, data, warnings: [] };
  const parsed = parseCliEnvelope(candidate);
  if (!parsed.ok) {
    throw new CliCommandError("internal_error", "The success envelope failed validation.");
  }
  return parsed.value;
}

function failureEnvelope(command: string, error: unknown): CommandResult {
  const mapped = mapError(error);
  const candidate = {
    schema_version: CLI_SCHEMA_VERSION,
    ok: false,
    command,
    error: { code: mapped.code, message: mapped.message, details: mapped.details },
    warnings: [],
  } as const;
  const parsed = parseCliEnvelope(candidate);
  if (!parsed.ok) {
    return {
      envelope: {
        schema_version: CLI_SCHEMA_VERSION,
        ok: false,
        command: "internal-error",
        error: {
          code: "internal_error",
          message: "The CLI failure envelope was invalid.",
          details: {},
        },
        warnings: [],
      },
      exitCode: 5,
    };
  }
  return { envelope: parsed.value, exitCode: mapped.exitCode };
}

function successExitCode(command: string, data: JsonValue): number {
  if (command === "doctor" && isJsonObject(data) && data["healthy"] === false) {
    return 4;
  }
  return 0;
}

function mapError(
  error: unknown,
): Readonly<{ code: string; message: string; details: JsonObject; exitCode: number }> {
  if (error instanceof ArgumentError) {
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode: 1,
    };
  }
  if (error instanceof CliCommandError) {
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: error.code === "internal_error" ? 5 : 1,
    };
  }
  if (error instanceof PathBoundaryError) {
    return {
      code: "trust_boundary_failed",
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: 4,
    };
  }
  if (error instanceof LockError) {
    return {
      code: error.code === "lock_live" ? "capability_denied" : "trust_boundary_failed",
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: error.code === "lock_live" ? 2 : 4,
    };
  }
  if (error instanceof InstallerError) {
    const exitCode =
      error.code === "capability_denied" ? 2 : error.code === "state_corrupt" ? 4 : 3;
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode,
    };
  }
  if (error instanceof OfficialPluginManagerError) {
    return {
      code: error.code === "command_failed" ? "capability_denied" : "install_failed",
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: error.code === "command_failed" ? 2 : 3,
    };
  }
  if (error instanceof MarketplaceError) {
    return {
      code: "state_corrupt",
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: 4,
    };
  }
  if (error instanceof StorageError) {
    return { code: error.code, message: sanitizeMessage(error.message), details: {}, exitCode: 4 };
  }
  if (error instanceof CleanupError) {
    return { code: error.code, message: sanitizeMessage(error.message), details: {}, exitCode: 3 };
  }
  if (error instanceof ManifestError) {
    return { code: error.code, message: sanitizeMessage(error.message), details: {}, exitCode: 1 };
  }
  if (error instanceof WorkflowHostError) {
    const denied = error.code === "capability_denied" || error.code === "approval_required";
    const uncertain = error.code === "external_failed" || error.code === "effect_uncertain";
    const integrity = error.code === "state_corrupt" || error.code === "integrity_uncertain";
    return {
      code: denied
        ? "capability_denied"
        : integrity
          ? error.code
          : uncertain
            ? "effect_uncertain"
            : "run_failed",
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode: denied ? 2 : uncertain || integrity ? 4 : 3,
    };
  }
  if (error instanceof CodexError) {
    const denied =
      error.code === "capability_unavailable" ||
      error.code === "model_unsupported" ||
      error.code === "permission_denied" ||
      error.code === "approval_required";
    const uncertain = error.code === "execution_failed";
    return {
      code: denied ? "capability_denied" : uncertain ? "effect_uncertain" : "run_failed",
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode: denied ? 2 : uncertain ? 4 : 3,
    };
  }
  if (error instanceof WorkflowStoreError) {
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: error.code === "workflow_missing" ? 1 : 4,
    };
  }
  if (error instanceof RefinementStoreError) {
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: error.code === "refinement_missing" ? 1 : 4,
    };
  }
  if (error instanceof WorkflowCommandError) {
    const exitCode =
      error.code === "invalid_argument" || error.code === "unknown_command"
        ? 1
        : error.code === "unsupported" || error.code === "capability_denied"
          ? 2
          : 4;
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode,
    };
  }
  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: "The command failed unexpectedly.",
      details: {},
      exitCode: 5,
    };
  }
  return {
    code: "internal_error",
    message: "The command failed unexpectedly.",
    details: {},
    exitCode: 5,
  };
}

function inferCommand(argv: readonly string[]): string {
  const words = argv.filter((item) => !item.startsWith("--"));
  return words.slice(0, words[0] === "workflow" ? 3 : 1).join(" ") || "unknown";
}

function sanitizeMessage(message: string): string {
  let safe = "";
  for (const character of message) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe += codePoint <= 31 || codePoint === 127 ? " " : character;
  }
  return safe.replace(/\s+/gu, " ").trim().slice(0, 512);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitProgress(context: CliContext, json: boolean, message: string): void {
  if (json || parsedVerbose(context) === false) {
    return;
  }
  context.io?.writeStderr?.(`${message}\n`);
}

function parsedVerbose(context: CliContext): boolean {
  return context.io?.stderrIsTTY === true || context.io?.stderrIsTTY === undefined;
}

export function renderHuman(result: CommandResult): string {
  if (result.envelope.ok) {
    return `${result.envelope.command}: ok\n${JSON.stringify(result.envelope.data, null, 2)}\n`;
  }
  return `${result.envelope.command}: error ${result.envelope.error.code}\n${result.envelope.error.message}\n`;
}

export class CliCommandError extends Error {
  readonly code: "invalid_argument" | "non_tty_confirmation_required" | "internal_error";

  constructor(
    code: "invalid_argument" | "non_tty_confirmation_required" | "internal_error",
    message: string,
  ) {
    super(message);
    this.name = "CliCommandError";
    this.code = code;
  }
}
