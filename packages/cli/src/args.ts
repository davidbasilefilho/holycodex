// SPDX-License-Identifier: Apache-2.0

import { lookupPlan, ServiceTierSchema } from "@holycodex/core";
import type { ParsedCommand } from "./types.ts";
import { AutonomySchema, decodeSchema } from "./schema.ts";

const VALUE_OPTIONS = new Set([
  "codex-home",
  "marketplace-root",
  "plan",
  "tier",
  "scope",
  "run-id",
  "session-id",
  "official-plugin",
  "task",
  "autonomy",
  "max-subagents",
  "max-subagent",
]);
const BOOLEAN_OPTIONS = new Set([
  "yes",
  "json",
  "verbose",
  "dry-run",
  "follow",
  "trusted",
  "compat-quickjs",
  "computer-use",
  "no-computer-use",
  "work",
  "no-work",
  "web",
  "no-web",
  "security",
  "no-security",
  "fast",
  "no-tui",
]);

export class ArgumentError extends Error {
  readonly code: "unknown_command" | "invalid_argument";
  readonly details: Readonly<Record<string, string>>;

  constructor(code: "unknown_command" | "invalid_argument", message: string, details = {}) {
    super(message);
    this.name = "ArgumentError";
    this.code = code;
    this.details = details;
  }
}

export function parseArgv(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0) {
    throw new ArgumentError("unknown_command", "A command is required.");
  }
  if (argv.includes("-h") || argv.includes("--help") || argv.includes("--help=true")) {
    return { command: "help", positionals: [], options: {} };
  }
  if (argv[0] === "help") {
    return { command: "help", positionals: argv.slice(1), options: {} };
  }
  if (argv[0] === "-v") {
    return parseArgv(["version", ...argv.slice(1)]);
  }
  if (argv[0] === "--version") {
    return parseArgv(["version", ...argv.slice(1)]);
  }
  if (argv[0] === "--version=true") {
    return parseArgv(["version", ...argv.slice(1)]);
  }
  const [top, second, third, ...rest] = argv;
  if (
    top !== "install" &&
    top !== "doctor" &&
    top !== "cleanup" &&
    top !== "version" &&
    top !== "workflow"
  ) {
    throw new ArgumentError("unknown_command", "Unknown command.", { command: top ?? "" });
  }
  const commandParts = [top];
  let remainder: string[] = [...rest];
  if (top === "workflow") {
    if (second === undefined || second.startsWith("-")) {
      throw new ArgumentError("unknown_command", "A workflow command is required.");
    }
    commandParts.push(second === "continue" ? "continuation" : second);
    remainder = [third, ...rest].filter((value): value is string => value !== undefined);
    if (second === "refinement") {
      const refinement = remainder.shift();
      if (!refinement || refinement.startsWith("-")) {
        throw new ArgumentError("unknown_command", "A workflow refinement command is required.");
      }
      commandParts.push(refinement);
    }
  } else {
    remainder = [second, third, ...rest].filter((value): value is string => value !== undefined);
  }

  const positionals: string[] = [];
  const options: Record<string, string | boolean | readonly string[]> = {};
  for (let index = 0; index < remainder.length; index += 1) {
    const token = remainder[index];
    if (token === undefined) {
      continue;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith("--") || token === "--") {
      throw new ArgumentError("invalid_argument", "Short options are not supported.", {
        option: token,
      });
    }
    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    const inlineValue = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : undefined;
    const normalizedName = normalizeOptionName(name);
    if (!VALUE_OPTIONS.has(normalizedName) && !BOOLEAN_OPTIONS.has(normalizedName)) {
      throw new ArgumentError("invalid_argument", "Unknown option.", { option: `--${name}` });
    }
    if (VALUE_OPTIONS.has(normalizedName)) {
      const value = inlineValue ?? remainder[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new ArgumentError("invalid_argument", `Option --${name} requires a value.`, {
          option: `--${name}`,
        });
      }
      if (inlineValue === undefined) {
        index += 1;
      }
      const canonicalName = normalizedName === "max-subagent" ? "max-subagents" : normalizedName;
      if (canonicalName === "official-plugin") {
        const previous = options[normalizedName];
        const values = Array.isArray(previous) ? [...previous, value] : [value];
        options[canonicalName] = values;
      } else {
        if (options[canonicalName] !== undefined) {
          throw new ArgumentError(
            "invalid_argument",
            `Option --${name} may only be supplied once.`,
            { option: `--${name}` },
          );
        }
        options[canonicalName] = value;
      }
      continue;
    }
    if (inlineValue !== undefined && inlineValue !== "true" && inlineValue !== "false") {
      throw new ArgumentError("invalid_argument", `Option --${name} is boolean.`, {
        option: `--${name}`,
      });
    }
    const value = inlineValue === "false" ? false : true;
    if (options[normalizedName] !== undefined) {
      throw new ArgumentError("invalid_argument", `Option --${name} may only be supplied once.`, {
        option: `--${name}`,
      });
    }
    options[normalizedName] = value;
  }
  const command = commandParts.join(" ");
  validateCommand(command, positionals, options);
  return { command, positionals, options };
}

function normalizeOptionName(name: string): string {
  return name.replaceAll("_", "-");
}

function validateCommand(
  command: string,
  positionals: readonly string[],
  options: Readonly<Record<string, string | boolean | readonly string[]>>,
): void {
  const allowed = commandOptions(command);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new ArgumentError("invalid_argument", `Option --${key} is not valid for ${command}.`, {
        option: `--${key}`,
      });
    }
  }
  const expected = positionalRange(command);
  if (positionals.length < expected.min || positionals.length > expected.max) {
    throw new ArgumentError("invalid_argument", `Invalid positional arguments for ${command}.`);
  }
  const plan = options["plan"];
  if (typeof plan === "string" && !lookupPlan(plan).ok) {
    throw new ArgumentError("invalid_argument", "The plan is not supported.", { plan });
  }
  const tier = options["tier"];
  if (typeof tier === "string" && decodeSchema(ServiceTierSchema, tier) === undefined) {
    throw new ArgumentError("invalid_argument", "The tier is not supported.", { tier });
  }
  const autonomy = options["autonomy"];
  if (typeof autonomy === "string" && decodeSchema(AutonomySchema, autonomy) === undefined) {
    throw new ArgumentError("invalid_argument", "The autonomy mode is not supported.", {
      autonomy,
    });
  }
  const maxSubagents = options["max-subagents"];
  if (
    typeof maxSubagents === "string" &&
    (!/^\d+$/u.test(maxSubagents) ||
      Number(maxSubagents) < 1 ||
      !Number.isSafeInteger(Number(maxSubagents)))
  ) {
    throw new ArgumentError("invalid_argument", "The maximum specialist count is invalid.", {
      max_subagents: maxSubagents,
    });
  }
  if (
    options["scope"] !== undefined &&
    options["scope"] !== "run" &&
    options["scope"] !== "workspace" &&
    options["scope"] !== "expired" &&
    options["scope"] !== "workflow-session"
  ) {
    throw new ArgumentError("invalid_argument", "The cleanup scope is not supported.", {
      scope: String(options["scope"]),
    });
  }
  if (options["fast"] === true && options["tier"] !== undefined) {
    throw new ArgumentError("invalid_argument", "Conflicting --fast and --tier options.");
  }
  if (command === "cleanup" && options["scope"] === undefined) {
    throw new ArgumentError("invalid_argument", "Cleanup requires --scope.");
  }
  if (
    command === "workflow inspect" &&
    options["follow"] !== undefined &&
    typeof options["follow"] !== "boolean"
  ) {
    throw new ArgumentError("invalid_argument", "--follow is boolean.");
  }
  const positiveNegativePairs = [
    ["computer-use", "no-computer-use"],
    ["work", "no-work"],
    ["web", "no-web"],
    ["security", "no-security"],
  ] as const;
  for (const [positive, negative] of positiveNegativePairs) {
    if (options[positive] !== undefined && options[negative] !== undefined) {
      throw new ArgumentError(
        "invalid_argument",
        `Conflicting --${positive} and --${negative} options.`,
      );
    }
  }
}

function positionalRange(command: string): { readonly min: number; readonly max: number } {
  switch (command) {
    case "version":
      return { min: 0, max: 1 };
    case "workflow run":
      return { min: 1, max: 2 };
    case "workflow show":
    case "workflow inspect":
    case "workflow pause":
    case "workflow restart":
    case "workflow reopen":
    case "workflow stop":
      return { min: 1, max: 1 };
    case "workflow resume":
      return { min: 2, max: 3 };
    case "workflow continuation":
      return { min: 2, max: 3 };
    case "workflow goal":
      return { min: 2, max: 2 };
    case "workflow stop-agent":
      return { min: 2, max: 2 };
    case "workflow save":
      return { min: 3, max: 3 };
    case "workflow invoke":
      return { min: 2, max: 3 };
    case "workflow refinement show":
    case "workflow refinement enable":
    case "workflow refinement disable":
      return { min: 1, max: 1 };
    default:
      return { min: 0, max: 0 };
  }
}

function commandOptions(command: string): ReadonlySet<string> {
  const common = ["json", "verbose", "no-tui"];
  switch (command) {
    case "install":
      return new Set([
        ...common,
        "yes",
        "codex-home",
        "marketplace-root",
        "plan",
        "tier",
        "fast",
        "autonomy",
        "max-subagents",
        "official-plugin",
        ...optionalChoiceOptions(),
      ]);
    case "doctor":
      return new Set([...common, "codex-home", "marketplace-root"]);
    case "cleanup":
      return new Set([
        ...common,
        "yes",
        "scope",
        "run-id",
        "session-id",
        "codex-home",
        "marketplace-root",
      ]);
    case "version":
      return new Set([...common, "dry-run"]);
    case "workflow run":
      return new Set([
        ...common,
        "task",
        "plan",
        "tier",
        "fast",
        "autonomy",
        "max-subagents",
        "trusted",
        "compat-quickjs",
      ]);
    case "workflow resume":
      return new Set([...common, "trusted", "compat-quickjs"]);
    case "workflow continuation":
      return new Set([...common, "trusted", "compat-quickjs"]);
    case "workflow inspect":
      return new Set([...common, "follow"]);
    case "workflow save":
      return new Set([...common, "trusted", "compat-quickjs"]);
    case "workflow invoke":
      return new Set([...common, "trusted", "compat-quickjs"]);
    default:
      if (command.startsWith("workflow")) {
        return new Set(common);
      }
      return new Set(common);
  }
}

function optionalChoiceOptions(): readonly string[] {
  return [
    "computer-use",
    "no-computer-use",
    "work",
    "no-work",
    "web",
    "no-web",
    "security",
    "no-security",
  ];
}
