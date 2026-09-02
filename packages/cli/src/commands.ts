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
import { doctorHolyCodex, removeHolyCodex } from "./maintenance.ts";
import { readCanonicalVersion, updateCanonicalVersion, ManifestError } from "./manifest.ts";
import { PathBoundaryError } from "./paths.ts";
import { installHolyCodex, InstallerError, type InstallRequest } from "./installer.ts";
import { StorageError } from "./storage.ts";
import { OfficialPluginManagerError } from "./official-manager.ts";
import { asJsonValue } from "./json.ts";
import { helpRequested, helpText, helpTopic } from "./help.ts";
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
  emitProgress(context, json, "install: validating target");
  const request: InstallRequest = {
    ...(optionPlan(parsed) === undefined ? {} : { plan: optionPlan(parsed) }),
    ...(optionTier(parsed) === undefined ? {} : { tier: optionTier(parsed) }),
    ...(optionalSelections(parsed) === undefined ? {} : { optional: optionalSelections(parsed) }),
    ...(optionStrings(parsed, "add-plugin").length === 0
      ? {}
      : { officialPlugins: optionStrings(parsed, "add-plugin") }),
  };
  const result = await installHolyCodex(request, installerOptions(parsed, context), context.env);
  emitProgress(context, json, "install: activated");
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
  emitProgress(context, json, "remove: validating ownership");
  const result = await removeHolyCodex(installerOptions(parsed, context), context.env);
  emitProgress(context, json, "remove: complete");
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
    paths: { ...(base.paths ?? {}), codexHome },
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

function isJsonObject(value: JsonValue): value is JsonObject {
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

function colorEnabled(options: HumanRenderOptions): boolean {
  const env = options.env ?? {};
  if (env["NO_COLOR"] !== undefined || env["TERM"] === "dumb") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  if (env["CI"] !== undefined && env["CI"] !== "false") return false;
  const tty = options.stream === "stderr" ? options.stderrIsTTY : options.stdoutIsTTY;
  return tty === true;
}

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
