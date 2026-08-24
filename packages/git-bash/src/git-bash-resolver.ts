// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { posix, win32 } from "node:path";
import { GitBashError } from "./errors.ts";

export const GIT_BASH_CAPABILITY_NAME = "git_bash" as const;
export const GIT_BASH_ENV_KEY = "HOLYCODEX_GIT_BASH_PATH" as const;

const PROGRAM_FILES_GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PROGRAM_FILES_X86_GIT_BASH = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
const DEFAULT_INSTALL_HINT = `Git Bash required. Install: winget install --id Git.Git -e --source winget\nCustom path: set ${GIT_BASH_ENV_KEY}=C:\\path\\to\\bash.exe`;
const EnvironmentShapeSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const ResolverShapeSchema = Schema.Struct({
  platform: Schema.String.pipe(Schema.minLength(1)),
  env: EnvironmentShapeSchema,
});

export type GitBashCapabilityName = typeof GIT_BASH_CAPABILITY_NAME;
export type GitBashSource = "not-required" | "env" | "program-files" | "program-files-x86" | "path";
export type GitBashResolution =
  | Readonly<{
      readonly found: true;
      readonly path: string | null;
      readonly source: GitBashSource;
      readonly checkedPaths: readonly string[];
    }>
  | Readonly<{
      readonly found: false;
      readonly checkedPaths: readonly string[];
      readonly installHint: string;
    }>;

export type GitBashFileProbe = "file" | "symlink" | "reparse" | "missing";

export type GitBashResolverInput = Readonly<{
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  readonly where: (command: "bash") => readonly string[];
  readonly inspect?: ((path: string) => GitBashFileProbe) | undefined;
}>;

export type GitBashCurrentProcessInput = Readonly<{
  readonly platform?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly exists?: ((path: string) => boolean) | undefined;
  readonly where?: ((command: "bash") => readonly string[]) | undefined;
  readonly inspect?: ((path: string) => GitBashFileProbe) | undefined;
}>;

/** Resolves a verified Git Bash executable using deterministic Windows probes. */
export function resolveGitBash(input: GitBashResolverInput): GitBashResolution {
  const environment = validateResolverInput(input);
  if (input.platform !== "win32") {
    return found(null, "not-required", []);
  }

  const checkedPaths: string[] = [];
  const configured = environment[GIT_BASH_ENV_KEY]?.trim();
  if (configured !== undefined && configured.length > 0) {
    checkedPaths.push(configured);
    const normalized = normalizeGitBashExecutablePath(configured, input.platform);
    if (normalized !== null && available(input, configured, normalized)) {
      return found(normalized, "env", checkedPaths);
    }
    return missing(
      checkedPaths,
      `${GIT_BASH_ENV_KEY} is configured but invalid or unavailable; refusing fallback.\n${DEFAULT_INSTALL_HINT}`,
    );
  }

  const fixedCandidates = [
    { path: PROGRAM_FILES_GIT_BASH, source: "program-files" as const },
    { path: PROGRAM_FILES_X86_GIT_BASH, source: "program-files-x86" as const },
  ];
  for (const candidate of fixedCandidates) {
    checkedPaths.push(candidate.path);
    const normalized = normalizeGitBashExecutablePath(candidate.path, input.platform);
    if (normalized !== null && available(input, candidate.path, normalized)) {
      return found(normalized, candidate.source, checkedPaths);
    }
  }

  let pathCandidates: readonly string[];
  try {
    pathCandidates = validateWhereOutput(input.where("bash"));
  } catch (error: unknown) {
    return missing(
      checkedPaths,
      `${DEFAULT_INSTALL_HINT}\nPATH lookup failed: ${errorMessage(error)}`,
    );
  }

  const seen = new Set<string>();
  for (const raw of pathCandidates) {
    const candidate = raw.trim();
    if (candidate.length === 0) continue;
    checkedPaths.push(candidate);
    const normalized = normalizeGitBashExecutablePath(candidate, input.platform);
    if (normalized === null) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (available(input, candidate, normalized)) {
      return found(normalized, "path", checkedPaths);
    }
  }

  return missing(checkedPaths);
}

/** Resolves Git Bash using the current process and injectable platform seams. */
export function resolveGitBashForCurrentProcess(
  input: GitBashCurrentProcessInput = {},
): GitBashResolution {
  const platform = input.platform ?? process.platform;
  const environment = input.env ?? process.env;
  return resolveGitBash({
    platform,
    env: environment,
    exists: input.exists ?? defaultExists,
    inspect:
      input.inspect ??
      (input.exists === undefined
        ? defaultInspect
        : (path) => (safeExists(input.exists!, path) ? "file" : "missing")),
    where:
      input.where ??
      ((command) => {
        if (platform !== "win32") return [];
        return whereGitBash(command, environment);
      }),
  });
}

/** Normalizes and validates an explicit Git Bash executable path without resolving links. */
export function normalizeGitBashExecutablePath(value: string, platform: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\u0000")) return null;
  const separators = platform === "win32" ? trimmed.replaceAll("/", "\\") : trimmed;
  const segments = separators.split(platform === "win32" ? "\\" : "/");
  if (segments.includes("..")) return null;

  const normalized =
    platform === "win32" ? win32.normalize(separators) : posix.normalize(separators);
  const absolute =
    platform === "win32" ? win32.isAbsolute(normalized) : posix.isAbsolute(normalized);
  if (!absolute) return null;

  const basename = (
    platform === "win32" ? win32.basename(normalized) : posix.basename(normalized)
  ).toLowerCase();
  if (
    platform === "win32" ? basename !== "bash.exe" : basename !== "bash" && basename !== "bash.exe"
  ) {
    return null;
  }
  if (platform === "win32" && isRejectedWindowsAlias(normalized)) return null;
  return normalized;
}

/** Checks a candidate without following symbolic links or reparse aliases. */
export function isSafeGitBashExecutablePath(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function validateResolverInput(
  input: GitBashResolverInput,
): Readonly<Record<string, string | undefined>> {
  const decoded = Schema.decodeUnknownEither(ResolverShapeSchema, {
    onExcessProperty: "error",
  })({ platform: input.platform, env: input.env });
  if (Either.isLeft(decoded)) {
    throw new GitBashError(
      "invalid_input",
      "Git Bash resolver input is invalid.",
      {},
      { cause: decoded.left },
    );
  }
  const environment: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(decoded.right.env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\u0000")) {
      throw new GitBashError("invalid_input", "Git Bash environment keys are invalid.");
    }
    if (value !== undefined && typeof value !== "string") {
      throw new GitBashError("invalid_input", "Git Bash environment values must be text.");
    }
    environment[key] = value;
  }
  return Object.freeze(environment);
}

function validateWhereOutput(value: readonly string[]): readonly string[] {
  const decoded = Schema.decodeUnknownEither(Schema.Array(Schema.String), {
    onExcessProperty: "error",
  })(value);
  if (Either.isLeft(decoded)) {
    throw new GitBashError(
      "unavailable",
      "The Windows PATH lookup returned invalid candidates.",
      {},
      { cause: decoded.left },
    );
  }
  return decoded.right;
}

function available(input: GitBashResolverInput, raw: string, normalized: string): boolean {
  const inspected = input.inspect === undefined ? "file" : safeInspect(input.inspect, normalized);
  if (inspected !== "file") return false;
  return (
    safeExists(input.exists, normalized) || (raw !== normalized && safeExists(input.exists, raw))
  );
}

function safeExists(exists: (path: string) => boolean, path: string): boolean {
  try {
    return exists(path) === true;
  } catch {
    return false;
  }
}

function safeInspect(inspect: (path: string) => GitBashFileProbe, path: string): GitBashFileProbe {
  try {
    return inspect(path);
  } catch {
    return "missing";
  }
}

function defaultExists(path: string): boolean {
  return isSafeGitBashExecutablePath(path);
}

function defaultInspect(path: string): GitBashFileProbe {
  return isSafeGitBashExecutablePath(path) ? "file" : "missing";
}

function whereGitBash(
  command: "bash",
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      windowsHide: true,
      env: whereEnvironment(environment),
    });
    return String(output)
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function whereEnvironment(input: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const entries = Object.entries(input);
  const exactPath = entries.find(([key, value]) => key === "PATH" && value !== undefined);
  const fallbackPath = [...entries]
    .reverse()
    .find(([key, value]) => key.toLowerCase() === "path" && value !== undefined);
  const pathEntry = exactPath ?? fallbackPath;
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of entries) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "path" || normalizedKey === "original_path" || value === undefined)
      continue;
    environment[key] = value;
  }
  if (pathEntry !== undefined) environment["PATH"] = pathEntry[1];
  return environment;
}

function isRejectedWindowsAlias(path: string): boolean {
  const normalized = path.toLowerCase().replaceAll("/", "\\");
  return (
    normalized.includes("\\windows\\system32\\") || normalized.split("\\").includes("windowsapps")
  );
}

function found(
  path: string | null,
  source: GitBashSource,
  checkedPaths: readonly string[],
): GitBashResolution {
  return Object.freeze({
    found: true as const,
    path,
    source,
    checkedPaths: Object.freeze([...checkedPaths]),
  });
}

function missing(
  checkedPaths: readonly string[],
  installHint: string = DEFAULT_INSTALL_HINT,
): GitBashResolution {
  return Object.freeze({
    found: false as const,
    checkedPaths: Object.freeze([...checkedPaths]),
    installHint,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
