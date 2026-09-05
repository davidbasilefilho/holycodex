// SPDX-License-Identifier: Apache-2.0

import { lookupProfile } from "@holycodex/core";

import type { ParsedCommand } from "./types.ts";

export const INSTALL_OPTION_CATALOG = Object.freeze([
  { name: "yes", kind: "boolean", usage: "--yes", description: "Confirm installation." },
  {
    name: "profile",
    kind: "value",
    usage: "--profile <low|default|high>",
    description: "Select routing (default: default).",
  },
  {
    name: "tier",
    kind: "value",
    usage: "--tier <standard|fast|fast-all>",
    description: "Select service handling (default: standard).",
  },
  {
    name: "work",
    kind: "boolean",
    usage: "--work / --no-work",
    description: "Work plugins (default: false).",
  },
  {
    name: "frontend",
    kind: "boolean",
    usage: "--frontend / --no-frontend",
    description: "Frontend plugins via build-web-apps (default: true).",
  },
  {
    name: "security",
    kind: "boolean",
    usage: "--security / --no-security",
    description: "Security plugins (default: true).",
  },
  {
    name: "computer-use",
    kind: "boolean",
    usage: "--computer-use / --no-computer-use",
    description: "Computer Use plugins (default: false).",
  },
  {
    name: "add-plugin",
    kind: "value",
    usage: "--add-plugin <id>",
    description: "Add a Codex plugin; repeatable.",
  },
  { name: "json", kind: "boolean", usage: "--json", description: "Emit one JSON envelope." },
] as const);

const VALUE_OPTIONS = new Set(["codex-home", "profile", "tier", "add-plugin"]);
const BOOLEAN_OPTIONS = new Set([
  "yes",
  "json",
  "verbose",
  "dry-run",
  "computer-use",
  "no-computer-use",
  "work",
  "no-work",
  "frontend",
  "no-frontend",
  "security",
  "no-security",
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
  if (argv.length === 0) throw new ArgumentError("unknown_command", "A command is required.");
  if (argv.includes("-h") || argv.includes("--help") || argv.includes("--help=true")) {
    return { command: "help", positionals: [], options: {} };
  }
  if (argv[0] === "help") return { command: "help", positionals: argv.slice(1), options: {} };
  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "--version=true") {
    return parseArgv(["version", ...argv.slice(1)]);
  }
  const command = argv[0];
  if (
    command !== "install" &&
    command !== "doctor" &&
    command !== "remove" &&
    command !== "version"
  ) {
    throw new ArgumentError("unknown_command", "Unknown command.", { command: command ?? "" });
  }
  const positionals: string[] = [];
  const options: Record<string, string | boolean | readonly string[]> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
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
    const rawName = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    const inlineValue = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : undefined;
    const name = rawName.replaceAll("_", "-");
    if (name === "plan") {
      throw new ArgumentError(
        "invalid_argument",
        "The --plan option was removed; use --profile <low|default|high>.",
        { option: "--plan", replacement: "--profile" },
      );
    }
    if (!VALUE_OPTIONS.has(name) && !BOOLEAN_OPTIONS.has(name)) {
      throw new ArgumentError("invalid_argument", "Unknown option.", { option: `--${rawName}` });
    }
    if (VALUE_OPTIONS.has(name)) {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new ArgumentError("invalid_argument", `Option --${rawName} requires a value.`, {
          option: `--${rawName}`,
        });
      }
      if (inlineValue === undefined) index += 1;
      if (name === "add-plugin") {
        const previous = options[name];
        options[name] = Array.isArray(previous) ? [...previous, value] : [value];
      } else {
        if (options[name] !== undefined) {
          throw new ArgumentError(
            "invalid_argument",
            `Option --${rawName} may only be supplied once.`,
            {
              option: `--${rawName}`,
            },
          );
        }
        options[name] = value;
      }
      continue;
    }
    if (inlineValue !== undefined && inlineValue !== "true" && inlineValue !== "false") {
      throw new ArgumentError("invalid_argument", `Option --${rawName} is boolean.`, {
        option: `--${rawName}`,
      });
    }
    if (options[name] !== undefined) {
      throw new ArgumentError(
        "invalid_argument",
        `Option --${rawName} may only be supplied once.`,
        {
          option: `--${rawName}`,
        },
      );
    }
    options[name] = inlineValue === "false" ? false : true;
  }
  validateCommand(command, positionals, options);
  return { command, positionals, options };
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
  const expected = command === "version" ? { min: 0, max: 1 } : { min: 0, max: 0 };
  if (positionals.length < expected.min || positionals.length > expected.max) {
    throw new ArgumentError("invalid_argument", `Invalid positional arguments for ${command}.`);
  }
  const profile = options["profile"];
  if (typeof profile === "string" && !lookupProfile(profile).ok) {
    const replacement = LEGACY_PROFILE_REPLACEMENTS[profile];
    if (replacement !== undefined) {
      throw new ArgumentError(
        "invalid_argument",
        `Legacy profile ${profile} was removed; use --profile ${replacement}.`,
        { profile, replacement },
      );
    }
    if (profile === "go" || profile === "Go" || profile === "pro-5x" || profile === "pro-20x") {
      throw new ArgumentError(
        "invalid_argument",
        `Legacy profile ${profile} was removed and requires an explicit replacement using --profile <low|default|high>.`,
        { profile },
      );
    }
    throw new ArgumentError("invalid_argument", "The profile is not supported.", { profile });
  }
  const tier = options["tier"];
  if (typeof tier === "string" && tier !== "standard" && tier !== "fast" && tier !== "fast-all") {
    throw new ArgumentError("invalid_argument", "The tier is not supported.", { tier });
  }
  for (const [positive, negative] of [
    ["computer-use", "no-computer-use"],
    ["work", "no-work"],
    ["frontend", "no-frontend"],
    ["security", "no-security"],
  ] as const) {
    if (options[positive] !== undefined && options[negative] !== undefined) {
      throw new ArgumentError(
        "invalid_argument",
        `Conflicting --${positive} and --${negative} options.`,
      );
    }
  }
  if (command === "install" && options["yes"] === false) {
    throw new ArgumentError("invalid_argument", "--yes cannot be false.");
  }
  if (
    command !== "install" &&
    Object.keys(options).some((key) =>
      [
        "profile",
        "tier",
        "work",
        "no-work",
        "frontend",
        "no-frontend",
        "security",
        "no-security",
        "computer-use",
        "no-computer-use",
        "add-plugin",
      ].includes(key),
    )
  ) {
    throw new ArgumentError(
      "invalid_argument",
      `Installation options are not valid for ${command}.`,
    );
  }
}

const LEGACY_PROFILE_REPLACEMENTS: Readonly<Record<string, "low" | "default" | "high">> = {
  "plus-low": "low",
  plus: "default",
  "plus-high": "high",
};

function commandOptions(command: string): ReadonlySet<string> {
  switch (command) {
    case "install":
      return new Set([
        ...INSTALL_OPTION_CATALOG.map((option) => option.name),
        "no-work",
        "no-frontend",
        "no-security",
        "no-computer-use",
        "codex-home",
        "verbose",
      ]);
    case "doctor":
      return new Set(["json", "verbose", "codex-home"]);
    case "remove":
      return new Set(["yes", "json", "verbose", "codex-home"]);
    case "version":
      return new Set(["json", "verbose", "dry-run"]);
    default:
      return new Set();
  }
}
