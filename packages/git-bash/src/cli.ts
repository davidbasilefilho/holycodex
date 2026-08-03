#!/usr/bin/env node
import { argv, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { stackOrMessageFromError } from "@holycodex/runtime-core/errors";

import { resolveGitBashForCurrentProcess } from "./git-bash-resolver.js";
import { runGitBashCommand } from "./runner.js";

const DEFAULT_TIMEOUT_MS = 120_000;
type LauncherOptions = {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
};

/** Parses the stable Git Bash launcher command line. */
export function parseLauncherArgs(args: readonly string[]): LauncherOptions {
  const values = new Map<string, string>();
  const supported = new Set(["--cwd", "--command", "--timeout"]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--"))
      throw new Error(`Unexpected positional argument: ${token ?? ""}`);
    const separator = token.indexOf("=");
    const name = separator < 0 ? token : token.slice(0, separator);
    if (!supported.has(name)) throw new Error(`Unknown option: ${name}`);
    if (values.has(name)) throw new Error(`Repeated option: ${name}`);
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--")))
      throw new Error(`Missing value for ${name}`);
    values.set(name, value);
  }
  const command = values.get("--command");
  if (command === undefined) throw new Error("Missing required --command option.");
  const timeout = values.get("--timeout");
  if (timeout !== undefined && (!/^\d+$/.test(timeout) || Number(timeout) < 1))
    throw new Error("--timeout must be a positive integer in milliseconds.");
  const cwd = values.get("--cwd");
  return {
    command,
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(timeout),
  };
}

async function main(): Promise<void> {
  const options = parseLauncherArgs(argv.slice(2));
  const resolution = resolveGitBashForCurrentProcess();
  if (!resolution.found) throw new Error(resolution.installHint);
  if (resolution.path === null)
    throw new Error("The Git Bash launcher is available only on native Windows.");
  const result = await runGitBashCommand({
    bashPath: resolution.path,
    command: options.command,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
  });
  stdout.write(result.stdout);
  stderr.write(result.stderr);
  process.exitCode = result.timedOut ? 124 : (result.exitCode ?? 1);
}

if (argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    stderr.write(`${stackOrMessageFromError(error)}\n`);
    process.exitCode = 1;
  });
