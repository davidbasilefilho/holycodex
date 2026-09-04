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
import { colorEnabled, helpRequested, helpText, helpTopic } from "./help.ts";
import { installHolyCodex, InstallerError, type InstallRequest } from "./installer.ts";
import { asJsonValue } from "./json.ts";
import { doctorHolyCodex, removeHolyCodex } from "./maintenance.ts";
import { readCanonicalVersion, updateCanonicalVersion, ManifestError } from "./manifest.ts";
import { OfficialPluginManagerError } from "./official-manager.ts";
import { PathBoundaryError } from "./paths.ts";
import { StorageError } from "./storage.ts";
import type { CliContext, CommandResult, HumanRenderOptions, ParsedCommand } from "./types.ts";

export async function runCli(
  argv: readonly string[],
  context: CliContext = {},
): Promise<CommandResult> {
  if (helpRequested(argv) || argv[0] === "help") {
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
  const json = parsed.options["json"] === true;
  if (!(await confirmation(parsed, context, "Install HolyCodex into the selected Codex home?"))) {
    throw new CliCommandError(
      "non_tty_confirmation_required",
      "Install requires --yes in non-interactive mode.",
    );
  }
  emitProgress(context, json, "Validating Codex target");
  emitProgress(context, json, "Installing HolyCodex");
  emitProgress(context, json, "Installing selected capabilities");
  emitProgress(context, json, "Configuring Root");
  emitProgress(context, json, "Installing subagent roles");
  const request: InstallRequest = {
    ...(optionPlan(parsed) === undefined ? {} : { plan: optionPlan(parsed) }),
    ...(optionTier(parsed) === undefined ? {} : { tier: optionTier(parsed) }),
    ...(optionalSelections(parsed) === undefined ? {} : { optional: optionalSelections(parsed) }),
    ...(optionStrings(parsed, "add-plugin").length === 0
      ? {}
      : { officialPlugins: optionStrings(parsed, "add-plugin") }),
  };
  const result = await installHolyCodex(request, installerOptions(parsed, context), context.env);
  emitProgress(context, json, "Verifying installation");
  emitProgress(context, json, "HolyCodex installation complete");
  return result;
}

async function executeRemove(parsed: ParsedCommand, context: CliContext) {
  const json = parsed.options["json"] === true;
  if (!(await confirmation(parsed, context, "Remove HolyCodex-owned Codex state?"))) {
    throw new CliCommandError(
      "non_tty_confirmation_required",
      "Remove requires --yes in non-interactive mode.",
    );
  }
  emitProgress(context, json, "Validating HolyCodex ownership");
  const result = await removeHolyCodex(installerOptions(parsed, context), context.env);
  emitProgress(context, json, "Removing HolyCodex-owned state");
  emitProgress(context, json, "HolyCodex removal complete");
  return result;
}

async function executeVersion(parsed: ParsedCommand, _context: CliContext) {
  const target = parsed.positionals[0];
  if (!target) return { version: await readCanonicalVersion() };
  return await updateCanonicalVersion(target, parsed.options["dry-run"] === true);
}

async function confirmation(
  parsed: ParsedCommand,
  context: CliContext,
  message: string,
): Promise<boolean> {
  if (parsed.options["yes"] === true) return true;
  if (parsed.options["json"] === true || context.io?.stdoutIsTTY !== true) return false;
  return await confirmIfAvailable(context, message);
}

async function confirmIfAvailable(context: CliContext, message: string): Promise<boolean> {
  return context.io?.confirm ? await context.io.confirm(message) : false;
}

function optionalSelections(parsed: ParsedCommand) {
  const result: Record<string, boolean> = {};
  for (const key of ["computer_use", "work", "frontend", "security"] as const) {
    const positive = key.replaceAll("_", "-");
    if (parsed.options[positive] === true) result[key] = true;
    else if (parsed.options[positive] === false) result[key] = false;
    else if (parsed.options[`no-${positive}`] === true) result[key] = false;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function optionPlan(parsed: ParsedCommand): PlanName | undefined {
  const value = parsed.options["plan"];
  if (typeof value !== "string") return undefined;
  const result = lookupPlan(value);
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
  const codexHome = parsed.options["codex-home"];
  if (typeof codexHome !== "string")
    return { ...base, ...(context.now ? { now: context.now } : {}) };
  return {
    ...base,
    paths: { ...base.paths, codexHome },
    ...(context.now ? { now: context.now } : {}),
  };
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
      error.code === "capability_denied" ? 2 : error.code === "state_corrupt" ? 4 : 3;
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
  const record = objectValue(data, "record");
  const version = stringValue(record, "version") ?? "unknown";
  const plan = stringValue(record, "plan") ?? "unknown";
  const tier = stringValue(record, "tier") ?? "unknown";
  const selections = objectValue(record, "optional_selections");
  const capabilityState = objectValue(record, "capability_state");
  const capabilities = ["frontend", "security", "work", "computer_use"]
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
    `  ${paint("plan", "option", color)}: ${plan}`,
    `  ${paint("tier", "option", color)}: ${tier}`,
    `  ${paint("capabilities", "option", color)}: ${capabilitySummary}`,
    `  ${paint("preserved", "option", color)}: ${preservedSummary}`,
    ...warnings.map((warning) => `  ${paint("warning", "red", color)}: ${humanizeReason(warning)}`),
  ];
  return `${lines.join("\n")}\n`;
}

function renderRemove(data: JsonValue, color: boolean): string {
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
  if (code === "invalid_argument" || code === "unknown_command")
    return `holycodex ${command} --help`;
  if (code === "non_tty_confirmation_required")
    return "rerun with --yes or use an interactive terminal";
  if (code === "capability_denied")
    return "run `holycodex doctor` to inspect capability availability";
  return undefined;
}

type Color = "red" | "green" | "cyan" | "dim" | "heading" | "option";

function paint(value: string, color: Color, enabled: boolean): string {
  if (!enabled) return value;
  const codes: Record<Color, string> = {
    red: "31",
    green: "32",
    cyan: "36",
    dim: "2",
    heading: "1",
    option: "36",
  };
  return `\u001b[${codes[color]}m${value}\u001b[0m`;
}

export class CliCommandError extends Error {
  readonly code: "invalid_argument" | "non_tty_confirmation_required" | "internal_error";

  constructor(code: CliCommandError["code"], message: string) {
    super(message);
    this.name = "CliCommandError";
    this.code = code;
  }
}
