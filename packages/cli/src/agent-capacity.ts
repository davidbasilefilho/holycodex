import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentCapacity } from "./core-instructions.ts";

const AGENTS_TABLE = /^\s*\[agents\]\s*(?:#.*)?$/;
const NEXT_TABLE = /^\s*\[/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

/** Parses agent limits from the root `[agents]` TOML table. */
export function parseAgentCapacity(config: string): AgentCapacity | undefined {
  const lines = config.split(/\r?\n/);
  const table = lines.findIndex((line) => AGENTS_TABLE.test(line));
  if (table < 0) return undefined;
  let maxThreads: number | undefined;
  let maxDepth: number | undefined;
  for (const line of lines.slice(table + 1)) {
    if (NEXT_TABLE.test(line)) break;
    const match = /^\s*(max_threads|max_depth)\s*=\s*([^#\s]+)\s*(?:#.*)?$/.exec(line);
    if (match === null || !POSITIVE_INTEGER.test(match[2] ?? "")) continue;
    const value = Number(match[2]);
    if (match[1] === "max_threads") maxThreads = value;
    else maxDepth = value;
  }
  return maxThreads === undefined || maxDepth === undefined ? undefined : { maxThreads, maxDepth };
}

/** Reads active agent limits without exposing other Codex configuration. */
export async function readAgentCapacity(
  codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
): Promise<AgentCapacity | undefined> {
  try {
    return parseAgentCapacity(await readFile(join(codexHome, "config.toml"), "utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
    )
      return undefined;
    throw error;
  }
}
