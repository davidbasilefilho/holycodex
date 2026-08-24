// SPDX-License-Identifier: Apache-2.0

import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ServerInstallationOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly exists?: (path: string) => boolean;
  readonly isFile?: (path: string) => boolean;
}

function executableExtensions(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  if (platform !== "win32") return [""];
  const raw = environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD;.PS1";
  const values = raw
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(["", ...values, ".exe", ".cmd", ".bat", ".ps1"])].map((value) =>
    value === "" || value.startsWith(".") ? value : `.${value}`,
  );
}

/** Resolves whether an existing executable is available without executing it. */
export function resolveServerExecutable(
  command: readonly string[],
  options: ServerInstallationOptions = {},
): string | null {
  const executable = command[0];
  if (!executable) return null;
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const exists = options.exists ?? existsSync;
  const isFile =
    options.isFile ??
    ((path: string) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
  const hasPath = executable.includes("/") || executable.includes("\\");
  const pathValue = environment["PATH"] ?? environment["Path"] ?? "";
  const directories = hasPath
    ? [""]
    : pathValue.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const suffix of executableExtensions(platform, environment)) {
      const candidate =
        directory === "" ? `${executable}${suffix}` : join(directory, `${executable}${suffix}`);
      if (exists(candidate) && isFile(candidate)) return candidate;
    }
  }
  if (executable === "node" && platform !== "win32") return executable;
  return null;
}

/** Checks for a language server on PATH or at an explicit executable path. */
export function isServerInstalled(
  command: readonly string[],
  options: ServerInstallationOptions = {},
): boolean {
  return resolveServerExecutable(command, options) !== null;
}
