import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const GIT_BASH_ENV_KEY = "HOLYCODEX_GIT_BASH_PATH";

const PROGRAM_FILES = "C:\\Program Files\\Git\\bin\\bash.exe";
const PROGRAM_FILES_X86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
const INVALID_LAUNCHERS = ["\\windows\\system32\\", "\\microsoft\\windowsapps\\"] as const;

export type GitBashSource = "not-required" | "env" | "program-files" | "program-files-x86" | "path";
export type GitBashResolution =
  | {
      readonly found: true;
      readonly path: string | null;
      readonly source: GitBashSource;
      readonly checkedPaths: readonly string[];
    }
  | {
      readonly found: false;
      readonly checkedPaths: readonly string[];
      readonly installHint: string;
    };

export interface GitBashResolverInput {
  readonly platform: string;
  readonly env: { readonly [key: string]: string | undefined };
  readonly exists: (path: string) => boolean;
  readonly where: (command: "bash") => readonly string[];
}

/** Resolves git bash. */
export function resolveGitBash(input: GitBashResolverInput): GitBashResolution {
  if (input.platform !== "win32")
    return { found: true, path: null, source: "not-required", checkedPaths: [] };
  const checkedPaths: string[] = [];
  const configured = input.env[GIT_BASH_ENV_KEY]?.trim();
  if (configured) {
    checkedPaths.push(configured);
    return isBash(configured) && input.exists(configured)
      ? { found: true, path: configured, source: "env", checkedPaths }
      : missing(checkedPaths);
  }
  for (const candidate of [
    { path: PROGRAM_FILES, source: "program-files" },
    { path: PROGRAM_FILES_X86, source: "program-files-x86" },
  ] as const) {
    checkedPaths.push(candidate.path);
    if (input.exists(candidate.path))
      return { found: true, path: candidate.path, source: candidate.source, checkedPaths };
  }
  for (const raw of input.where("bash")) {
    const candidate = raw.trim();
    if (!candidate) continue;
    checkedPaths.push(candidate);
    const normalized = candidate.replaceAll("/", "\\").toLowerCase();
    if (INVALID_LAUNCHERS.some((part) => normalized.includes(part))) continue;
    if (isBash(candidate) && input.exists(candidate))
      return { found: true, path: candidate, source: "path", checkedPaths };
  }
  return missing(checkedPaths);
}

/** Resolves git bash for current process. */
export function resolveGitBashForCurrentProcess(
  input: {
    readonly platform?: string;
    readonly env?: { readonly [key: string]: string | undefined };
  } = {},
): GitBashResolution {
  return resolveGitBash({
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
    exists: existsSync,
    where: (command) => {
      try {
        return execFileSync("where", [command], { encoding: "utf8" })
          .split(/\r?\n/)
          .filter(Boolean);
      } catch (error) {
        if (error instanceof Error) return [];
        throw error;
      }
    },
  });
}

function isBash(path: string): boolean {
  return path.toLowerCase().endsWith("bash.exe");
}

function missing(checkedPaths: readonly string[]): GitBashResolution {
  return {
    found: false,
    checkedPaths,
    installHint: `Git Bash required. Install: winget install --id Git.Git -e --source winget\nCustom path: set ${GIT_BASH_ENV_KEY}=C:\\path\\to\\bash.exe`,
  };
}
