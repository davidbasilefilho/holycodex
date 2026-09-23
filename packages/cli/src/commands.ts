// SPDX-License-Identifier: Apache-2.0

import {
  CLI_SCHEMA_VERSION,
  parseCliEnvelope,
  type CliEnvelope,
  type JsonObject,
  type JsonValue,
  type ProfileName,
  type ServiceTier,
} from "@holycodex/core";
import { lookupProfile } from "@holycodex/core";

import { ArgumentError, parseArgv } from "./args.ts";
import {
  colorEnabled,
  helpRequested,
  helpText,
  helpTopic,
  paintTerminal,
  type TerminalSemanticTone,
} from "./help.ts";
import {
  runOpenTuiConflictResolver,
  runOpenTuiInstallReview,
  runOpenTuiInstallWizard,
} from "./installer-wizard.ts";
import {
  installHolyCodex,
  InstallerError,
  readEffectiveInstallRequest,
  validateInstallOptions,
  type InstallRequest,
} from "./installer.ts";
import { asJsonValue } from "./json.ts";
import { doctorHolyCodex, inspectRemovalConflicts, removeHolyCodex } from "./maintenance.ts";
import { readPublicVersion, updateCanonicalVersion, ManifestError } from "./manifest.ts";
import { OfficialPluginManagerError } from "./official-manager.ts";
import { PathBoundaryError } from "./paths.ts";
import { StorageError } from "./storage.ts";
import type {
  CliContext,
  CommandResult,
  ConflictDecision,
  HumanRenderOptions,
  InstallProgressEvent,
  InstallReview,
  InstallReviewResult,
  InstallerOptions,
  ManagedConflict,
  ParsedCommand,
} from "./types.ts";

/** Parse and execute CLI arguments, returning a validated envelope and exit code. */
export async function runCli(
  argv: readonly string[],
  context: CliContext = {},
): Promise<CommandResult> {
  if (argv.length === 0 || helpRequested(argv) || argv[0] === "help") {
    const topic =
      argv[0] === "help"
        ? argv.slice(1).filter((value) => !value.startsWith("-"))[0]
        : helpTopic(argv);
    return {
      envelope: successEnvelope(topic === undefined ? "help" : `${topic} help`, {
        help: helpText(topic),
      }),
      exitCode: 0,
    };
  }
  let parsed: ParsedCommand | undefined;
  try {
    parsed = parseArgv(argv);
    const data = await executeCommand(parsed, context);
    return {
      envelope: successEnvelope(parsed.command, data),
      exitCode: successExitCode(parsed.command, data),
    };
  } catch (error: unknown) {
    return failureEnvelope(parsed?.command ?? inferCommand(argv), error);
  }
}

/** Dispatch a parsed command to its installer, maintenance, or version operation. */
export async function executeCommand(
  parsed: ParsedCommand,
  context: CliContext,
): Promise<JsonValue> {
  switch (parsed.command) {
    case "install":
      return asJsonValue(await executeInstall(parsed, context));
    case "doctor":
      return asJsonValue(await doctorHolyCodex(installerOptions(parsed, context), context.env));
    case "remove":
      return asJsonValue(await executeRemove(parsed, context));
    case "version":
      return asJsonValue(await executeVersion(parsed, context));
    case "help":
      return { help: helpText(parsed.positionals[0]) };
    default:
      throw new CliCommandError("invalid_argument", "Unknown command.");
  }
}

async function executeInstall(parsed: ParsedCommand, context: CliContext) {
  const initialRequest = installRequestFromParsed(parsed);
  const request = await resolveInstallRequest(parsed, context, initialRequest);
  if ("cancelled" in request) return request;
  const result = await installHolyCodex(request, installerOptions(parsed, context), context.env);
  return result;
}

/** Resolve one validated install request from flags or the interactive wizard. */
async function resolveInstallRequest(
  parsed: ParsedCommand,
  context: CliContext,
  initial: InstallRequest,
): Promise<InstallRequest | { readonly cancelled: true }> {
  const interactive =
    parsed.options["json"] !== true &&
    parsed.options["yes"] !== true &&
    context.io?.stdoutIsTTY === true &&
    context.io?.stderrIsTTY === true;
  if (interactive) {
    const previous = await readEffectiveInstallRequest(
      installerOptions(parsed, context),
      context.env,
    );
    const result = await (context.io?.installWizard ?? runOpenTuiInstallWizard)({
      ...previous,
      ...initial,
      ...(previous.optional === undefined && initial.optional === undefined
        ? {}
        : { optional: { ...previous.optional, ...initial.optional } }),
    });
    if (result.action === "cancel") {
      return { cancelled: true };
    }
    return validateInstallOptions(result.request);
  }
  const confirmationResult = await confirmation(
    parsed,
    context,
    "Install HolyCodex into the selected Codex home?",
  );
  if (confirmationResult === "cancelled") return { cancelled: true };
  if (confirmationResult === "unavailable") {
    throw new CliCommandError(
      "non_tty_confirmation_required",
      "Install requires --yes in non-interactive mode.",
    );
  }
  return validateInstallOptions(initial);
}

function installRequestFromParsed(parsed: ParsedCommand): InstallRequest {
  const profile = optionProfile(parsed);
  const tier = optionTier(parsed);
  const optional = optionalSelections(parsed);
  const officialPlugins =
    parsed.options["add-plugin"] === undefined ? undefined : optionStrings(parsed, "add-plugin");
  return validateInstallOptions({
    ...(profile === undefined ? {} : { profile }),
    ...(tier === undefined ? {} : { tier }),
    ...(optional === undefined ? {} : { optional }),
    ...(officialPlugins === undefined ? {} : { officialPlugins }),
  });
}

async function executeRemove(parsed: ParsedCommand, context: CliContext) {
  const confirmationResult = await confirmation(
    parsed,
    context,
    "Remove HolyCodex-owned Codex state?",
  );
  if (confirmationResult === "cancelled") {
    return { cancelled: true, removed: [], preserved: [], reasons: ["cancelled"] };
  }
  if (confirmationResult === "unavailable") {
    const conflict = (
      await inspectRemovalConflicts(installerOptions(parsed, context), context.env)
    )[0];
    if (conflict !== undefined) {
      throw new InstallerError(
        "confirmation_required",
        "Modified HolyCodex-owned state requires confirmation before removal.",
        undefined,
        {
          path: conflict.path,
          ...(conflict.key === undefined ? {} : { key: conflict.key }),
          action: conflict.action,
        },
      );
    }
    throw new CliCommandError(
      "non_tty_confirmation_required",
      "Remove requires --yes in non-interactive mode.",
    );
  }
  const result = await removeHolyCodex(installerOptions(parsed, context), context.env);
  return result;
}

async function executeVersion(parsed: ParsedCommand, _context: CliContext) {
  const target = parsed.positionals[0];
  if (!target) return { version: await readPublicVersion() };
  return await updateCanonicalVersion(target, parsed.options["dry-run"] === true);
}

async function confirmation(
  parsed: ParsedCommand,
  context: CliContext,
  message: string,
): Promise<ConfirmationResult> {
  if (parsed.options["yes"] === true) return "confirmed";
  if (
    parsed.options["json"] === true ||
    context.io?.stdoutIsTTY !== true ||
    context.io?.stderrIsTTY !== true
  )
    return "unavailable";
  return await confirmIfAvailable(context, message);
}

async function confirmIfAvailable(
  context: CliContext,
  message: string,
): Promise<ConfirmationResult> {
  if (context.io?.confirm === undefined) return "unavailable";
  const result = await context.io.confirm(message);
  if (result === "confirmed" || result === "cancelled" || result === "unavailable") return result;
  return result ? "confirmed" : "cancelled";
}

function optionalSelections(parsed: ParsedCommand) {
  const result: Record<string, boolean> = {};
  for (const key of ["computer_use", "frontend", "security"] as const) {
    const positive = key.replaceAll("_", "-");
    if (parsed.options[positive] === true) result[key] = true;
    else if (parsed.options[positive] === false) result[key] = false;
    else if (parsed.options[`no-${positive}`] === true) result[key] = false;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function optionProfile(parsed: ParsedCommand): ProfileName | undefined {
  const value = parsed.options["profile"];
  if (typeof value !== "string") return undefined;
  const result = lookupProfile(value);
  return result.ok ? result.value.name : undefined;
}

function optionTier(parsed: ParsedCommand): ServiceTier | undefined {
  const value = parsed.options["tier"];
  return value === "standard" || value === "fast" || value === "fast-all" ? value : undefined;
}

function optionStrings(parsed: ParsedCommand, key: string): readonly string[] {
  const value = parsed.options[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function installerOptions(parsed: ParsedCommand, context: CliContext) {
  const base = context.installer ?? {};
  const json = parsed.options["json"] === true;
  const interactiveReview =
    !json &&
    parsed.options["yes"] !== true &&
    context.io?.stdoutIsTTY === true &&
    context.io?.stderrIsTTY === true;
  const onProgress = (event: InstallProgressEvent): void => {
    base.onProgress?.(event);
    context.onProgress?.(event);
    emitProgress(context, json, event.message);
  };
  const selectedConflictDecisions = new Map<string, ConflictDecision>();
  const recordConflictDecisions = (
    conflicts: readonly ManagedConflict[],
    decisions: Readonly<Record<string, ConflictDecision>>,
  ): Readonly<Record<string, ConflictDecision>> => {
    for (const conflict of conflicts) {
      const identity = conflictIdentity(conflict);
      const decision = decisions[identity];
      if (decision !== undefined) selectedConflictDecisions.set(identity, decision);
    }
    return decisions;
  };
  const resolveConflict: NonNullable<InstallerOptions["resolveConflict"]> =
    base.resolveConflict ??
    (parsed.options["yes"] === true
      ? async () => "accept" as const
      : async (conflict) => {
          const target =
            conflict.key === undefined ? conflict.path : `${conflict.path} (${conflict.key})`;
          const result = await confirmIfAvailable(
            context,
            `${conflict.action === "remove" ? "Remove" : "Replace"} modified HolyCodex-owned state at ${target}?`,
          );
          return result === "confirmed"
            ? ("accept" as const)
            : result === "cancelled"
              ? ("decline" as const)
              : ("cancel" as const);
        });
  const configuredResolveConflicts: NonNullable<InstallerOptions["resolveConflicts"]> =
    base.resolveConflicts ??
    (parsed.options["yes"] === true
      ? async (conflicts) =>
          Object.fromEntries(
            conflicts.map((conflict) => [conflict.identity ?? conflict.path, "replace"]),
          )
      : async (conflicts) => {
          if (
            parsed.options["json"] === true ||
            context.io?.stdoutIsTTY !== true ||
            context.io?.stderrIsTTY !== true
          ) {
            throw new InstallerError(
              "confirmation_required",
              "Managed conflicts require an interactive review or --yes.",
            );
          }
          const result = await runOpenTuiConflictResolver(
            conflicts,
            {},
            Object.fromEntries(selectedConflictDecisions),
          );
          if (result.action === "back") {
            return Object.fromEntries(
              conflicts.map((conflict) => {
                const identity = conflictIdentity(conflict);
                const selected = selectedConflictDecisions.get(identity);
                return [identity, selected ?? defaultConflictDecision(conflict)];
              }),
            );
          }
          if (result.action === "cancel")
            throw new InstallerError("confirmation_required", "Conflict review was cancelled.");
          if (result.action === "continue") return result.decisions;
          throw new InstallerError("confirmation_required", "Conflict review was reopened.");
        });
  const resolveConflicts: NonNullable<InstallerOptions["resolveConflicts"]> = async (conflicts) =>
    recordConflictDecisions(conflicts, await configuredResolveConflicts(conflicts));
  const configuredReview = base.reviewInstall ?? context.io?.installReview;
  const review =
    configuredReview ??
    (parsed.options["yes"] === true
      ? async (): Promise<InstallReviewResult> => ({ action: "apply" })
      : interactiveReview
        ? async (plan: InstallReview): Promise<InstallReviewResult> =>
            await runOpenTuiInstallReview(plan)
        : undefined);
  const reviewInstall =
    review === undefined
      ? undefined
      : async (plan: InstallReview): Promise<InstallReviewResult> => {
          const reviewedPlan = withSelectedConflictDecisions(plan, selectedConflictDecisions);
          const result = await review(installReviewForCli(reviewedPlan));
          if (result.action !== "change") return result;
          if (result.request !== undefined) {
            return { action: "change", request: validateInstallOptions(result.request) };
          }
          if (!interactiveReview) {
            throw new InstallerError(
              "confirmation_required",
              "Changing install options requires an interactive review.",
            );
          }
          const changed = await (context.io?.installWizard ?? runOpenTuiInstallWizard)(
            installRequestFromReview(reviewedPlan),
          );
          if (changed.action === "cancel") return { action: "cancel" };
          return { action: "change", request: validateInstallOptions(changed.request) };
        };
  const codexHome = parsed.options["codex-home"];
  if (typeof codexHome !== "string")
    return {
      ...base,
      onProgress,
      resolveConflict,
      resolveConflicts,
      ...(reviewInstall === undefined ? {} : { reviewInstall }),
      ...(context.now ? { now: context.now } : {}),
    };
  return {
    ...base,
    paths: { ...base.paths, codexHome },
    onProgress,
    resolveConflict,
    resolveConflicts,
    ...(reviewInstall === undefined ? {} : { reviewInstall }),
    ...(context.now ? { now: context.now } : {}),
  };
}

function installRequestFromReview(plan: InstallReview): InstallRequest {
  return validateInstallOptions({
    profile: plan.profile,
    tier: plan.tier,
    optional: plan.capabilities,
    officialPlugins: plan.additionalPlugins,
  });
}

function conflictIdentity(conflict: ManagedConflict): string {
  return conflict.identity ?? conflict.path;
}

function defaultConflictDecision(conflict: ManagedConflict): ConflictDecision {
  const preferred = conflict.defaultDecision ?? "replace";
  if (preferred === "keep" || preferred === "replace" || preferred === "cancel") {
    if (conflict.validDecisions === undefined || conflict.validDecisions.includes(preferred)) {
      return preferred;
    }
  }
  return (
    conflict.validDecisions?.find((decision) => decision === "keep" || decision === "replace") ??
    "keep"
  );
}

function withSelectedConflictDecisions(
  plan: InstallReview,
  selected: ReadonlyMap<string, ConflictDecision>,
): InstallReview {
  if (selected.size === 0 || plan.conflicts.length === 0) return plan;
  return {
    ...plan,
    conflicts: plan.conflicts.map((conflict) => {
      const decision = selected.get(conflictIdentity(conflict));
      return decision === undefined ? conflict : { ...conflict, decision };
    }),
  };
}

function installReviewForCli(plan: InstallReview): InstallReview {
  const { fromVersion: _fromVersion, ...installPlan } = plan;
  return { ...installPlan, operation: "install" };
}

function successEnvelope(command: string, data: JsonValue): CliEnvelope {
  const parsed = parseCliEnvelope({
    schema_version: CLI_SCHEMA_VERSION,
    ok: true,
    command,
    data,
    warnings: [],
  });
  if (!parsed.ok)
    throw new CliCommandError("internal_error", "The success envelope failed validation.");
  return parsed.value;
}

function failureEnvelope(command: string, error: unknown): CommandResult {
  const mapped = mapError(error);
  const parsed = parseCliEnvelope({
    schema_version: CLI_SCHEMA_VERSION,
    ok: false,
    command,
    error: { code: mapped.code, message: mapped.message, details: mapped.details },
    warnings: [],
  });
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
  return command === "doctor" && isJsonObject(data) && data["healthy"] === false ? 4 : 0;
}

function mapError(
  error: unknown,
): Readonly<{ code: string; message: string; details: JsonObject; exitCode: number }> {
  if (error instanceof ArgumentError)
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode: 1,
    };
  if (error instanceof CliCommandError)
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: error.code === "internal_error" ? 5 : 1,
    };
  if (error instanceof PathBoundaryError)
    return {
      code: "trust_boundary_failed",
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: 4,
    };
  if (error instanceof InstallerError) {
    const exitCode =
      error.code === "confirmation_required"
        ? 1
        : error.code === "capability_denied"
          ? 2
          : error.code === "state_corrupt"
            ? 4
            : 3;
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode,
    };
  }
  if (error instanceof OfficialPluginManagerError) {
    const uncertain = ["timeout", "output_limit", "cancelled", "readback_mismatch"].includes(
      error.code,
    );
    const denied =
      error.code === "plugin_disabled" ||
      error.code === "plugin_missing" ||
      error.code === "command_failed";
    return {
      code: uncertain ? "effect_uncertain" : denied ? "capability_denied" : "install_failed",
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode: uncertain ? 4 : denied ? 2 : 3,
    };
  }
  if (error instanceof StorageError)
    return { code: error.code, message: sanitizeMessage(error.message), details: {}, exitCode: 4 };
  if (error instanceof ManifestError)
    return { code: error.code, message: sanitizeMessage(error.message), details: {}, exitCode: 1 };
  if (error instanceof Error)
    return {
      code: "internal_error",
      message: "The command failed unexpectedly.",
      details: {},
      exitCode: 5,
    };
  return {
    code: "internal_error",
    message: "The command failed unexpectedly.",
    details: {},
    exitCode: 5,
  };
}

function inferCommand(argv: readonly string[]): string {
  return argv.find((item) => !item.startsWith("-")) ?? "unknown";
}

function sanitizeMessage(message: string): string {
  return Array.from(message)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitProgress(context: CliContext, json: boolean, message: string): void {
  if (json || context.io?.stderrIsTTY === false) return;
  context.io?.writeStderr?.(
    `${renderProgress(message, { stderrIsTTY: context.io?.stderrIsTTY, env: context.env })}\n`,
  );
}

type ConfirmationResult = "confirmed" | "cancelled" | "unavailable";

/** Render a command result as human-readable terminal output. */
export function renderHuman(result: CommandResult, options: HumanRenderOptions = {}): string {
  const color = colorEnabled(options);
  if (result.envelope.ok) {
    if (result.envelope.command === "version") return renderVersion(result.envelope.data);
    if (result.envelope.command === "install") return renderInstall(result.envelope.data, color);
    if (result.envelope.command === "remove") return renderRemove(result.envelope.data, color);
    if (result.envelope.command === "doctor") return renderDoctor(result.envelope.data, color);
    return `${paint("✔", "green", color)} ${paint(result.envelope.command, "heading", color)}\n${renderData(result.envelope.data, color)}`;
  }
  const error = result.envelope.error;
  const hint = actionableHint(error.code, result.envelope.command);
  return [
    `${paint("✖", "red", color)} ${paint(result.envelope.command, "heading", color)}`,
    `  ${paint(error.code, "red", color)}: ${error.message}`,
    ...renderDetails(error.details, color),
    ...(hint === undefined ? [] : [`  hint: ${hint}`]),
    "",
  ].join("\n");
}

/** Render a progress message using the terminal's configured semantic color. */
export function renderProgress(
  message: string,
  options: Pick<HumanRenderOptions, "stderrIsTTY" | "env"> = {},
): string {
  return `${paint("•", "cyan", colorEnabled({ ...options, stream: "stderr" }))} ${message}`;
}

function renderVersion(data: JsonValue): string {
  if (isJsonObject(data) && typeof data["version"] === "string") {
    return `holycodex ${data["version"]}\n`;
  }
  if (isJsonObject(data) && typeof data["next"] === "string") {
    const previous = typeof data["previous"] === "string" ? ` (from ${data["previous"]})` : "";
    return `holycodex version updated to ${data["next"]}${previous}\n`;
  }
  return "holycodex version completed\n";
}

function renderInstall(data: JsonValue, color: boolean): string {
  if (dataValue(data, "cancelled") === true) {
    return `${paint("↩", "cyan", color)} ${paint("install", "heading", color)} cancelled\n`;
  }
  const record = objectValue(data, "record");
  const version = stringValue(record, "version") ?? "unknown";
  const profile = stringValue(record, "profile") ?? "unknown";
  const tier = stringValue(record, "tier") ?? "unknown";
  const selections = objectValue(record, "optional_selections");
  const capabilityState = objectValue(record, "capability_state");
  const capabilities = ["frontend", "security", "computer_use"]
    .filter((name) => selections?.[name] === true)
    .map((name) => {
      const status = stringValue(objectValue(capabilityState, name), "status");
      return status === undefined || status === "healthy" ? name : `${name} (${status})`;
    });
  const preserved = arrayValue(data, "preserved");
  const warnings = arrayValue(data, "warnings");
  const capabilitySummary = capabilities.length === 0 ? "none" : capabilities.join(", ");
  const preservedSummary =
    preserved.length === 0
      ? "none"
      : `${preserved.length} managed item${preserved.length === 1 ? "" : "s"} (review before retrying)`;
  const lines = [
    `${paint("✔", "green", color)} ${paint("install", "heading", color)}`,
    `  ${paint("version", "option", color)}: ${version}`,
    `  ${paint("profile", "option", color)}: ${profile}`,
    `  ${paint("tier", "option", color)}: ${tier}`,
    `  ${paint("capabilities", "option", color)}: ${capabilitySummary}`,
    `  ${paint("preserved", "option", color)}: ${preservedSummary}`,
    ...warnings.map(
      (warning) => `  ${paint("warning", "warning", color)}: ${humanizeReason(warning)}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function renderRemove(data: JsonValue, color: boolean): string {
  if (dataValue(data, "cancelled") === true) {
    return `${paint("↩", "cyan", color)} ${paint("remove", "heading", color)} cancelled\n`;
  }
  const removed = arrayValue(data, "removed");
  const preserved = arrayValue(data, "preserved");
  const reasons = arrayValue(data, "reasons");
  const preservedSummary =
    preserved.length === 0
      ? "none"
      : `${preserved.length} item${preserved.length === 1 ? "" : "s"} (review before retrying)`;
  const lines = [
    `${paint("✔", "green", color)} ${paint("remove", "heading", color)}`,
    `  ${paint("removed", "option", color)}: ${removed.length} owned item${removed.length === 1 ? "" : "s"}`,
    `  ${paint("preserved", "option", color)}: ${preservedSummary}`,
    ...reasons.map((reason) => `  ${paint("reason", "option", color)}: ${humanizeReason(reason)}`),
  ];
  return `${lines.join("\n")}\n`;
}

function renderDoctor(data: JsonValue, color: boolean): string {
  const healthy = dataValue(data, "healthy") === true;
  const checks = objectValue(data, "checks");
  const entries = checks === undefined ? [] : Object.entries(checks);
  const issues = entries.flatMap(([name, value]) => {
    const check = isJsonObject(value) ? value : undefined;
    const status = stringValue(check, "status");
    if (status === undefined || status === "healthy") return [];
    const reasons = arrayValue(check, "reasons");
    return [
      `  ${paint(name, "option", color)}: ${reasons.length === 0 ? status : reasons.map(humanizeReason).join(", ")}`,
    ];
  });
  const symbol = healthy ? paint("✔", "green", color) : paint("✖", "red", color);
  const lines = [
    `${symbol} ${paint("doctor", "heading", color)}`,
    `  ${paint("status", "option", color)}: ${healthy ? "healthy" : "needs attention"}`,
    `  ${paint("checks", "option", color)}: ${entries.length}`,
    ...(issues.length === 0 ? [] : [`  ${paint("issues", "option", color)}:`, ...issues]),
  ];
  return `${lines.join("\n")}\n`;
}

function objectValue(value: unknown, key: string): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined;
  return isJsonObject(value[key]) ? value[key] : undefined;
}

function dataValue(value: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

function stringValue(value: JsonObject | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" ? item : undefined;
}

function arrayValue(value: unknown, key: string): readonly JsonValue[] {
  if (!isJsonObject(value) || !Array.isArray(value[key])) return [];
  return value[key];
}

function humanizeReason(reason: JsonValue): string {
  if (typeof reason !== "string") return "operation requires review";
  return reason.replaceAll("_", " ");
}

function renderData(data: JsonValue, color: boolean): string {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return `  ${paint(formatValue(data), "dim", color)}\n`;
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  const width = Math.max(...entries.map(([key]) => key.length));
  return `${entries.map(([key, value]) => `  ${paint(key.padEnd(width), "option", color)}: ${formatValue(value)}`).join("\n")}\n`;
}

function renderDetails(details: JsonObject, color: boolean): readonly string[] {
  return Object.entries(details).map(
    ([key, value]) =>
      `  ${paint(key, "option", color)}: ${paint(formatValue(value), "dim", color)}`,
  );
}

function formatValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function actionableHint(code: string, command: string): string | undefined {
  if (code === "unknown_command") return "run `holycodex --help` to list supported commands";
  if (code === "invalid_argument") return `holycodex ${command} --help`;
  if (code === "non_tty_confirmation_required")
    return "rerun with --yes or use an interactive terminal";
  if (code === "capability_denied")
    return "run `holycodex doctor` to inspect capability availability";
  return undefined;
}

type Color = "red" | "green" | "cyan" | "dim" | "warning" | "heading" | "option";

function paint(value: string, color: Color, enabled: boolean): string {
  const tones: Record<Color, TerminalSemanticTone> = {
    red: "error",
    green: "success",
    cyan: "focus",
    dim: "hint",
    warning: "warning",
    heading: "heading",
    option: "option",
  };
  return paintTerminal(value, tones[color], enabled);
}

/** Structured failure returned by a CLI command boundary. */
export class CliCommandError extends Error {
  readonly code:
    | "invalid_argument"
    | "non_tty_confirmation_required"
    | "install_cancelled"
    | "internal_error";

  constructor(code: CliCommandError["code"], message: string) {
    super(message);
    this.name = "CliCommandError";
    this.code = code;
  }
}
