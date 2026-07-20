import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Filesystem access granted by the active Codex sandbox configuration. */
export type CodexAccessMode = "read-only" | "workspace-write" | "full-access";

const CONFIG_FILE_NAME = "config.toml";
const DEFAULT_CODEX_HOME_NAME = ".codex";
const SANDBOX_MODE_PATTERN = /^\s*sandbox_mode\s*=\s*"(?<value>[a-z-]+)"\s*(?:#.*)?$/;

/** Resolves access from the Codex config present when a tool is called. */
export async function resolveCodexAccessMode(): Promise<CodexAccessMode> {
  let config: string;
  try {
    config = await readFile(codexConfigPath(), "utf8");
  } catch {
    return "read-only";
  }

  const sandboxMode = parseSandboxMode(config);
  if (sandboxMode === "workspace-write") return "workspace-write";
  if (sandboxMode === "danger-full-access") return "full-access";
  return "read-only";
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), DEFAULT_CODEX_HOME_NAME), CONFIG_FILE_NAME);
}

function parseSandboxMode(config: string): string | undefined {
  let sandboxMode: string | undefined;
  let inTable = false;
  for (const line of config.split(/\r\n|\n|\r/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("[")) {
      inTable = true;
      continue;
    }
    if (inTable || !trimmedLine.startsWith("sandbox_mode")) continue;

    const value = SANDBOX_MODE_PATTERN.exec(line)?.groups?.value;
    if (value === undefined || sandboxMode !== undefined) return undefined;
    sandboxMode = value;
  }
  return sandboxMode;
}
