// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";

import type {
  Context7Manager,
  Context7ToolState,
  GitBashState,
  InstallerFileSystem,
  InstallerPlatform,
  InstallerProcessRunner,
  InstallerRuntime,
} from "./types.ts";

export const WINDOWS_GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
export const CONTEXT7_SPEC = "ctx7@latest";

const execFileAsync = promisify(execFile);
const nodeFiles: InstallerFileSystem = {
  access,
  readText: (path) => readFile(path, "utf8"),
  realpath,
};

/** Create the injectable platform/process boundary used by shared prerequisite management. */
export function createInstallerRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InstallerRuntime {
  return {
    platform: process.platform as InstallerPlatform,
    environment,
    processPath: process.execPath,
    files: nodeFiles,
    run: async (executable, args) => {
      try {
        const result = await execFileAsync(executable, [...args], {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, ...environment },
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error: unknown) {
        const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
        return {
          exitCode: typeof value.code === "number" ? value.code : 1,
          stdout: typeof value.stdout === "string" ? value.stdout : "",
          stderr:
            typeof value.stderr === "string"
              ? value.stderr
              : error instanceof Error
                ? error.message
                : "process failed",
        };
      }
    },
  };
}

/** Resolve the launcher's package-manager family without using registry-origin heuristics. */
export function detectContext7Manager(
  environment: Readonly<Record<string, string | undefined>>,
): Context7Manager | undefined {
  const execPath = normalize(environment["npm_execpath"] ?? "");
  const command = (environment["npm_command"] ?? "").toLowerCase();
  const agent = (environment["npm_config_user_agent"] ?? "").toLowerCase();
  if (execPath.includes("yarn") || execPath.includes("corepack") || agent.startsWith("yarn/")) {
    return undefined;
  }
  if (isExecutable(execPath, "pnpm") && command === "dlx") {
    return { launcher: "pnpm dlx", family: "pnpm", executable: "pnpm" };
  }
  if (isExecutable(execPath, "bunx") || (isExecutable(execPath, "bun") && command === "exec")) {
    return { launcher: "bunx", family: "bun", executable: "bun" };
  }
  if (
    isExecutable(execPath, "npx") ||
    execPath.endsWith("/npx-cli.js") ||
    (isExecutable(execPath, "npm") && command === "exec") ||
    (execPath.endsWith("/npm-cli.js") && command === "exec")
  ) {
    return { launcher: "npx", family: "npm", executable: "npm" };
  }
  return undefined;
}

/** Verify Git for Windows, installing it through WinGet when Windows has no healthy Git Bash. */
export async function ensureGitBash(
  runtime: InstallerRuntime,
  mutate: boolean,
): Promise<GitBashState> {
  if (runtime.platform !== "win32") return { status: "not_applicable" };
  const existing = await discoverGitBash(runtime);
  if (existing !== undefined) return { status: "healthy", path: existing, installed: false };
  if (!mutate) return { status: "missing" };
  const installed = await runtime.run("winget", [
    "install",
    "--id",
    "Git.Git",
    "-e",
    "--source",
    "winget",
  ]);
  if (installed.exitCode !== 0) {
    throw new ToolingError(
      "git_bash_unavailable",
      "Git Bash is required. WinGet could not install Git for Windows; install Git.Git and retry.",
      { stderr: installed.stderr.slice(0, 512) },
    );
  }
  const repaired = await discoverGitBash(runtime);
  if (repaired === undefined) {
    throw new ToolingError(
      "git_bash_unavailable",
      `Git for Windows was installed, but ${WINDOWS_GIT_BASH} could not be verified. Repair Git for Windows and retry.`,
    );
  }
  return { status: "healthy", path: repaired, installed: true };
}

/** Reconcile ctx7@latest through the same package-manager family that launched HolyCodex. */
export async function ensureContext7(
  runtime: InstallerRuntime,
  mutate: boolean,
  previous?: Context7ToolState,
): Promise<Context7ToolState> {
  const manager = detectContext7Manager(runtime.environment);
  if (manager === undefined) {
    throw new ToolingError(
      "context7_manager_unknown",
      "HolyCodex must be launched with bunx, npx, or pnpm dlx so Context7 can use the same package manager.",
    );
  }
  const before = await inspectContext7(runtime, manager);
  const latest = await latestContext7Version(runtime, manager);
  if (latest === undefined) {
    throw new ToolingError(
      "context7_verification_failed",
      `${manager.family} could not resolve the latest ctx7 version.`,
    );
  }
  if (mutate && before?.version !== latest) {
    const command = context7InstallCommand(manager.family);
    const result = await runtime.run(command.executable, command.args);
    if (result.exitCode !== 0) {
      throw new ToolingError(
        "context7_install_failed",
        `${manager.family} could not install ${CONTEXT7_SPEC}.`,
        { stderr: result.stderr.slice(0, 512) },
      );
    }
  } else if (!mutate && before === undefined) {
    throw new ToolingError(
      "context7_unavailable",
      `${CONTEXT7_SPEC} is not owned by the ${manager.family} global installation.`,
    );
  }
  const after = await inspectContext7(runtime, manager);
  if (after === undefined) {
    throw new ToolingError(
      "context7_verification_failed",
      `${CONTEXT7_SPEC} could not be verified in the ${manager.family} global installation.`,
    );
  }
  if (after.version !== latest) {
    throw new ToolingError(
      "context7_outdated",
      `The ${manager.family} global ctx7 is ${after.version}; ${latest} is required.`,
      { installed: after.version, latest },
    );
  }
  return {
    manager: manager.family,
    launcher: manager.launcher,
    version: after.version,
    executable: after.executable,
    ownership: previous?.ownership ?? (before === undefined ? "holycodex" : "user"),
  };
}

/** Remove Context7 only when this installation recorded ownership and the launcher family agrees. */
export async function removeOwnedContext7(
  runtime: InstallerRuntime,
  previous: Context7ToolState | undefined,
): Promise<boolean> {
  if (previous?.ownership !== "holycodex") return false;
  const manager = detectContext7Manager(runtime.environment);
  if (manager === undefined || manager.family !== previous.manager) return false;
  let current: { readonly version: string; readonly executable: string } | undefined;
  try {
    current = await inspectContext7(runtime, manager);
  } catch (error) {
    if (error instanceof ToolingError && error.code === "context7_shadowed") return false;
    throw error;
  }
  if (
    current === undefined ||
    current.version !== previous.version ||
    !samePath(current.executable, previous.executable, runtime.platform)
  ) {
    return false;
  }
  const command = context7RemoveCommand(manager.family);
  const result = await runtime.run(command.executable, command.args);
  if (result.exitCode !== 0) {
    throw new ToolingError("context7_remove_failed", `${manager.family} could not remove ctx7.`, {
      stderr: result.stderr.slice(0, 512),
    });
  }
  try {
    if ((await inspectContext7(runtime, manager)) !== undefined) {
      throw new ToolingError(
        "context7_remove_failed",
        `${manager.family} reported success, but the recorded ctx7 installation is still present.`,
      );
    }
  } catch (error) {
    if (error instanceof ToolingError && error.code === "context7_remove_failed") throw error;
    throw new ToolingError(
      "context7_remove_failed",
      `${manager.family} removed ctx7, but its final state could not be verified.`,
    );
  }
  return true;
}

export function context7InstallCommand(family: Context7Manager["family"]): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  switch (family) {
    case "bun":
      return { executable: "bun", args: ["add", "--global", CONTEXT7_SPEC] };
    case "npm":
      return { executable: "npm", args: ["install", "--global", CONTEXT7_SPEC] };
    case "pnpm":
      return { executable: "pnpm", args: ["add", "--global", CONTEXT7_SPEC] };
  }
}

function context7RemoveCommand(family: Context7Manager["family"]): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  switch (family) {
    case "bun":
      return { executable: "bun", args: ["remove", "--global", "ctx7"] };
    case "npm":
      return { executable: "npm", args: ["uninstall", "--global", "ctx7"] };
    case "pnpm":
      return { executable: "pnpm", args: ["remove", "--global", "ctx7"] };
  }
}

async function discoverGitBash(runtime: InstallerRuntime): Promise<string | undefined> {
  if (await verifyGitBash(runtime.run, WINDOWS_GIT_BASH)) return WINDOWS_GIT_BASH;
  for (const directory of (runtime.environment["PATH"] ?? "").split(";")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, "bash.exe");
    if (await verifyGitBash(runtime.run, candidate)) return candidate;
  }
  return undefined;
}

async function verifyGitBash(run: InstallerProcessRunner, candidate: string): Promise<boolean> {
  const gitPath = gitForBash(candidate);
  const [bash, platform, git] = await Promise.all([
    run(candidate, ["--version"]),
    run(candidate, ["--noprofile", "--norc", "-c", "uname -s"]),
    run(gitPath, ["--version"]),
  ]);
  return (
    bash.exitCode === 0 &&
    /gnu bash/iu.test(bash.stdout) &&
    platform.exitCode === 0 &&
    /^mingw(?:32|64|)/iu.test(platform.stdout.trim()) &&
    git.exitCode === 0 &&
    /^git version \d/iu.test(git.stdout.trim())
  );
}

async function inspectContext7(
  runtime: InstallerRuntime,
  manager: Context7Manager,
): Promise<{ readonly version: string; readonly executable: string } | undefined> {
  const files = runtime.files ?? nodeFiles;
  const binResult = await runtime.run(
    manager.executable,
    manager.family === "npm"
      ? ["prefix", "--global"]
      : manager.family === "pnpm"
        ? ["bin", "--global"]
        : ["pm", "bin", "-g"],
  );
  if (binResult.exitCode !== 0) return undefined;
  const binRoot = binResult.stdout.trim();
  if (binRoot.length === 0) return undefined;
  const packageRoot =
    manager.family === "npm"
      ? pathFor(runtime.platform).join(binRoot, "node_modules", "ctx7")
      : manager.family === "pnpm"
        ? await pnpmPackageRoot(runtime, manager)
        : pathFor(runtime.platform).join(
            pathFor(runtime.platform).dirname(binRoot),
            "install",
            "global",
            "node_modules",
            "ctx7",
          );
  if (packageRoot === undefined) return undefined;
  let packageJson: { readonly version?: unknown; readonly bin?: unknown };
  try {
    packageJson = JSON.parse(
      await files.readText(pathFor(runtime.platform).join(packageRoot, "package.json")),
    ) as typeof packageJson;
  } catch {
    return undefined;
  }
  if (typeof packageJson.version !== "string") return undefined;
  const bin =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : isRecord(packageJson.bin) && typeof packageJson.bin["ctx7"] === "string"
        ? packageJson.bin["ctx7"]
        : undefined;
  if (bin === undefined) return undefined;
  const executable = pathFor(runtime.platform).resolve(packageRoot, bin);
  try {
    await files.access(executable);
    const canonicalPackageRoot = await files.realpath(packageRoot);
    const canonicalExecutable = await files.realpath(executable);
    if (!normalize(canonicalExecutable).startsWith(`${normalize(canonicalPackageRoot)}/`))
      return undefined;
  } catch {
    return undefined;
  }
  const shim = context7Shim(binRoot, manager.family, runtime.platform);
  let canonicalShim: string;
  try {
    await files.access(shim);
    canonicalShim = await files.realpath(shim);
  } catch {
    return undefined;
  }
  const shadow = await resolvePathExecutable(runtime.environment, runtime.platform, files);
  if (
    shadow !== undefined &&
    !samePath(await canonicalPath(files, shadow), canonicalShim, runtime.platform)
  ) {
    throw new ToolingError(
      "context7_shadowed",
      "A different ctx7 executable shadows the managed global installation.",
      {
        resolved: shadow,
        expected: shim,
      },
    );
  }
  if (shadow === undefined) return undefined;
  const version = await runtime.run(shim, ["--version"]);
  if (version.exitCode !== 0 || parseVersion(version.stdout) !== packageJson.version)
    return undefined;
  return { version: packageJson.version, executable: shim };
}

async function resolvePathExecutable(
  environment: Readonly<Record<string, string | undefined>>,
  platform: InstallerPlatform,
  files: InstallerFileSystem,
): Promise<string | undefined> {
  const path = environment["PATH"];
  if (path === undefined) return undefined;
  const names =
    platform === "win32"
      ? (environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter((extension) => extension.length > 0)
          .map((extension) => `ctx7${extension.toLowerCase()}`)
      : ["ctx7"];
  for (const directory of path.split(platform === "win32" ? ";" : ":")) {
    if (directory.length === 0) continue;
    for (const name of names) {
      const candidate = pathFor(platform).join(directory, name);
      try {
        await files.access(candidate);
        return candidate;
      } catch {
        // Keep searching the actual PATH order and PATHEXT precedence.
      }
    }
  }
  return undefined;
}

function context7Shim(
  binRoot: string,
  family: Context7Manager["family"],
  platform: InstallerPlatform,
): string {
  if (platform === "win32")
    return pathFor(platform).join(binRoot, family === "bun" ? "ctx7.exe" : "ctx7.cmd");
  return family === "npm"
    ? pathFor(platform).join(binRoot, "bin", "ctx7")
    : pathFor(platform).join(binRoot, "ctx7");
}

async function canonicalPath(files: InstallerFileSystem, path: string): Promise<string> {
  try {
    return await files.realpath(path);
  } catch {
    return path;
  }
}

function parseVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u)?.[1];
}

async function pnpmPackageRoot(
  runtime: InstallerRuntime,
  manager: Context7Manager,
): Promise<string | undefined> {
  const result = await runtime.run(manager.executable, ["root", "--global"]);
  const root = result.stdout.trim();
  return result.exitCode === 0 && root.length > 0
    ? pathFor(runtime.platform).join(root, "ctx7")
    : undefined;
}

async function latestContext7Version(
  runtime: InstallerRuntime,
  manager: Context7Manager,
): Promise<string | undefined> {
  const result = await runtime.run(
    manager.executable,
    manager.family === "bun" ? ["pm", "view", "ctx7", "version"] : ["view", "ctx7", "version"],
  );
  if (result.exitCode !== 0) return undefined;
  return parseVersion(result.stdout);
}

function gitForBash(candidate: string): string {
  const bin = dirname(candidate);
  const root = normalize(bin).endsWith("/usr/bin") ? resolve(bin, "..", "..") : resolve(bin, "..");
  return resolve(root, "cmd", "git.exe");
}

function isExecutable(path: string, name: string): boolean {
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.js`, `${name}.cjs`].some((candidate) =>
    path.endsWith(`/${candidate}`),
  );
}

function samePath(left: string, right: string, platform: InstallerPlatform): boolean {
  const pathApi = pathFor(platform);
  return normalize(pathApi.resolve(left)) === normalize(pathApi.resolve(right));
}

function pathFor(platform: InstallerPlatform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase().replace(/\/$/u, "");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ToolingError extends Error {
  constructor(
    readonly code:
      | "git_bash_unavailable"
      | "context7_manager_unknown"
      | "context7_unavailable"
      | "context7_install_failed"
      | "context7_remove_failed"
      | "context7_verification_failed"
      | "context7_outdated"
      | "context7_shadowed",
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ToolingError";
  }
}
