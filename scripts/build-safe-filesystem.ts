// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  SAFE_FILESYSTEM_HELPER_VERSION,
  SAFE_FILESYSTEM_PROTOCOL_VERSION,
  SafeFilesystemManifestSchema,
  type SafeFilesystemManifest,
} from "../packages/safe-filesystem/src/index.ts";
import { runChecked, type CommandResult } from "./process.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const sourcePath = join(workspaceRoot, "packages/safe-filesystem/native/safe_filesystem.c");
const fixedLinuxFlags = [
  "-std=c17",
  "-O2",
  "-D_FORTIFY_SOURCE=3",
  "-fstack-protector-strong",
  "-fPIE",
  "-pie",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-Wpedantic",
] as const;
const fixedWindowsFlags = [
  "/nologo",
  "/std:c17",
  "/O2",
  "/W4",
  "/WX",
  "/GS",
  "/guard:cf",
  "/Brepro",
  "/MT",
] as const;

type BuildCommandRunner = (
  command: readonly string[],
  options: Readonly<{
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxOutputBytes?: number;
  }>,
) => Promise<CommandResult>;

export type WindowsBuildEnvironmentDependencies = Readonly<{
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: BuildCommandRunner;
  readonly isRegularFile?: (path: string) => Promise<boolean>;
}>;

/** Resolves a deterministic MSVC x64 environment from the installed Visual Studio toolchain. */
export async function resolveWindowsBuildEnvironment(
  dependencies: WindowsBuildEnvironmentDependencies = {},
): Promise<Readonly<Record<string, string | undefined>>> {
  const environment = dependencies.env ?? process.env;
  if (environment["VCToolsInstallDir"] !== undefined) return environment;
  const run = dependencies.run ?? runChecked;
  const isRegularFile = dependencies.isRegularFile ?? defaultIsRegularFile;
  const programFilesRoots = [environment["ProgramFiles(x86)"], environment["ProgramFiles"]].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  let vswherePath: string | undefined;
  for (const root of programFilesRoots) {
    const candidate = join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    if (await isRegularFile(candidate)) {
      vswherePath = candidate;
      break;
    }
  }
  if (vswherePath === undefined) {
    throw new Error(
      "Microsoft Visual Studio Build Tools with the Desktop development with C++ workload are required to build the Windows safe filesystem helper.",
    );
  }
  const discovery = await run(
    [
      vswherePath,
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { cwd: workspaceRoot, env: environment, maxOutputBytes: 16 * 1024 },
  );
  const installationPath = discovery.stdout.trim();
  const vcvarsPath = join(installationPath, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (installationPath.length === 0 || !(await isRegularFile(vcvarsPath))) {
    throw new Error(
      "Microsoft Visual Studio Build Tools were found, but the x64 C++ build environment is unavailable.",
    );
  }
  const systemRoot = environment["SystemRoot"] ?? "C:\\Windows";
  const activated = await run(
    [
      join(systemRoot, "System32", "cmd.exe"),
      "/d",
      "/s",
      "/c",
      "call",
      vcvarsPath,
      "amd64",
      ">nul",
      "&&",
      "set",
    ],
    { cwd: workspaceRoot, env: environment, maxOutputBytes: 256 * 1024 },
  );
  const resolved: Record<string, string | undefined> = {};
  for (const line of activated.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    resolved[line.slice(0, separator)] = line.slice(separator + 1);
  }
  if (resolved["Path"] === undefined && resolved["PATH"] === undefined) {
    throw new Error("The Visual Studio x64 build environment did not provide PATH.");
  }
  return Object.freeze(resolved);
}

export async function buildSafeFilesystemArtifact(
  assetsRoot = join(workspaceRoot, "packages/cli/dist/assets/safe-filesystem"),
): Promise<SafeFilesystemManifest> {
  const source = await readFile(sourcePath);
  const sourceSha256 = sha256(source);
  const platform =
    process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : undefined;
  if (platform === undefined || process.arch !== "x64") {
    throw new Error(
      `Safe filesystem native compilation requires a pinned linux-x64 or win32-x64 host; observed ${process.platform}-${process.arch}.`,
    );
  }
  const key = `${platform}-x64`;
  const executable = platform === "win32" ? "safe-filesystem.exe" : "safe-filesystem";
  const outputDirectory = join(assetsRoot, key);
  const outputPath = join(outputDirectory, executable);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const buildEnvironment =
    platform === "win32" ? await resolveWindowsBuildEnvironment() : process.env;
  const compiler = platform === "win32" ? "cl.exe" : (process.env["CC"] ?? "cc");
  const compilerVersionResult = await runChecked(
    platform === "win32" ? [compiler, "/?"] : [compiler, "--version"],
    { cwd: workspaceRoot, env: buildEnvironment, maxOutputBytes: 64 * 1024 },
  );
  const compilerVersion = summarizeCompilerVersion(platform, compilerVersionResult);
  const sourceDefine =
    platform === "win32"
      ? `/DSAFE_FILESYSTEM_SOURCE_SHA256="${sourceSha256}"`
      : `-DSAFE_FILESYSTEM_SOURCE_SHA256="${sourceSha256}"`;
  const command =
    platform === "win32"
      ? [compiler, ...fixedWindowsFlags, sourceDefine, sourcePath, `/Fe:${outputPath}`]
      : [compiler, ...fixedLinuxFlags, sourceDefine, sourcePath, "-o", outputPath];
  await runChecked(command, {
    cwd: workspaceRoot,
    env: buildEnvironment,
    maxOutputBytes: 64 * 1024,
  });
  if (platform === "linux") await chmod(outputPath, 0o755);
  const helper = await readFile(outputPath);
  const manifestCandidate = {
    schemaVersion: "holycodex-safe-filesystem-artifact-v1",
    protocolVersion: SAFE_FILESYSTEM_PROTOCOL_VERSION,
    helperVersion: SAFE_FILESYSTEM_HELPER_VERSION,
    platform,
    architecture: "x64",
    executable,
    sourceSha256,
    helperSha256: sha256(helper),
    compiler,
    compilerVersion,
    flags: [...(platform === "win32" ? fixedWindowsFlags : fixedLinuxFlags), sourceDefine],
  } satisfies typeof SafeFilesystemManifestSchema.Type;
  const parsed = Schema.decodeUnknownEither(SafeFilesystemManifestSchema, {
    onExcessProperty: "error",
  })(manifestCandidate);
  if (Either.isLeft(parsed)) {
    throw new Error(`Safe filesystem artifact metadata failed validation: ${String(parsed.left)}`);
  }
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(parsed.right)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return parsed.right;
}

export function summarizeCompilerVersion(
  platform: "win32" | "linux",
  result: CommandResult,
): string {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  if (platform === "win32") {
    const banner = output.split(/\r?\n/u).find((line) => /Compiler Version/iu.test(line));
    if (banner !== undefined) return banner.slice(0, 4096);
  }
  return output.slice(0, 4096);
}

async function defaultIsRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.main) {
  try {
    const manifest = await buildSafeFilesystemArtifact();
    console.log(JSON.stringify({ status: "verified", ...manifest }));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "safe filesystem compilation failed",
      }),
    );
    process.exitCode = 1;
  }
}
