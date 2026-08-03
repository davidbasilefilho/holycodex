#!/usr/bin/env node
import { argv, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { stackOrMessageFromError } from "@holycodex/runtime-core/errors";

import { callToolViaDaemon, currentRequestContext } from "./daemon-client.js";
import { runDaemon } from "./run-daemon.js";

type CliInvocation = {
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly json: boolean;
};
const POSITION_COMMANDS = new Set([
  "definition",
  "declaration",
  "references",
  "prepare-rename",
  "rename",
]);

/** Parses the stable LSP CLI syntax with command-specific option validation. */
export function parseLspCliArgs(args: readonly string[]): CliInvocation {
  const command = args[0];
  if (command === undefined) throw new Error("Missing LSP command.");
  if (command === "daemon") return { command, args: {}, json: false };
  const supportedCommands = new Set([
    "status",
    "diagnostics",
    "definition",
    "declaration",
    "references",
    "document-symbols",
    "workspace-symbols",
    "prepare-rename",
    "rename",
  ]);
  if (!supportedCommands.has(command)) throw new Error(`Unknown LSP command: ${command}`);
  const options = new Map<string, string | true>();
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--"))
      throw new Error(`Unexpected positional argument: ${token ?? ""}`);
    const separator = token.indexOf("=");
    const name = separator < 0 ? token : token.slice(0, separator);
    if (options.has(name)) throw new Error(`Repeated option: ${name}`);
    if (name === "--json" || name === "--include-declaration") {
      if (separator >= 0) throw new Error(`${name} does not accept a value.`);
      options.set(name, true);
      continue;
    }
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--")))
      throw new Error(`Missing value for ${name}`);
    options.set(name, value);
  }
  const allowed = new Set<string>(["--json"]);
  if (command === "diagnostics") for (const name of ["--file", "--severity"]) allowed.add(name);
  if (POSITION_COMMANDS.has(command))
    for (const name of ["--file", "--line", "--character"]) allowed.add(name);
  if (command === "references") allowed.add("--include-declaration");
  if (command === "rename") allowed.add("--new-name");
  if (command === "document-symbols") allowed.add("--file");
  if (command === "workspace-symbols")
    for (const name of ["--file", "--query", "--limit"]) allowed.add(name);
  for (const name of options.keys())
    if (!allowed.has(name)) throw new Error(`Option ${name} is not valid for ${command}.`);
  const required =
    command === "status"
      ? []
      : command === "workspace-symbols"
        ? ["--file", "--query"]
        : command === "rename"
          ? ["--file", "--line", "--character", "--new-name"]
          : POSITION_COMMANDS.has(command)
            ? ["--file", "--line", "--character"]
            : ["--file"];
  for (const name of required)
    if (!options.has(name)) throw new Error(`Missing required ${name} option.`);
  const number = (name: string): number | undefined => {
    const value = options.get(name);
    if (typeof value !== "string") return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a nonnegative integer.`);
    return Number(value);
  };
  const filePath = options.get("--file");
  const toolArgs: Record<string, unknown> = {
    ...(typeof filePath === "string" ? { filePath } : {}),
    ...(number("--line") === undefined ? {} : { line: number("--line") }),
    ...(number("--character") === undefined ? {} : { character: number("--character") }),
  };
  if (command === "diagnostics") toolArgs["severity"] = options.get("--severity") ?? "all";
  if (command === "references")
    toolArgs["includeDeclaration"] = options.has("--include-declaration");
  if (command === "rename") toolArgs["newName"] = options.get("--new-name");
  if (command.endsWith("symbols")) {
    toolArgs["scope"] = command === "document-symbols" ? "document" : "workspace";
    if (options.has("--query")) toolArgs["query"] = options.get("--query");
    if (number("--limit") !== undefined) toolArgs["limit"] = number("--limit");
  }
  const tool =
    (
      {
        definition: "goto_definition",
        declaration: "goto_declaration",
        references: "find_references",
        "document-symbols": "symbols",
        "workspace-symbols": "symbols",
        "prepare-rename": "prepare_rename",
      } as Record<string, string>
    )[command] ?? command;
  return { command: tool, args: toolArgs, json: options.has("--json") };
}

async function main(): Promise<void> {
  const invocation = parseLspCliArgs(argv.slice(2));
  if (invocation.command === "daemon") {
    await runDaemon();
    return;
  }
  const result = await callToolViaDaemon(invocation.command, invocation.args, {
    context: currentRequestContext(),
  });
  stdout.write(
    invocation.json
      ? `${JSON.stringify(result)}\n`
      : `${result.content.map((item) => item.text).join("\n")}\n`,
  );
  if (result.isError) process.exitCode = 1;
}

if (argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    stderr.write(`${stackOrMessageFromError(error)}\n`);
    process.exitCode = 1;
  });
