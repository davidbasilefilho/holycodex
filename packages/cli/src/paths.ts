// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep, win32 } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { STATE_SCHEMA_EPOCH } from "@holycodex/core";
import type { InstallerOptions, InstallerPaths } from "./types.ts";

export const STATE_ROOT_NAME = "holycodex";
export const ACTIVE_RECORD_NAME = "active.json";
export const JOURNAL_NAME = "journal.ndjson";
export const LOCK_NAME = ".holycodex-install.lock";
export const PAYLOAD_DIRECTORY_NAME = "holycodex";
export const STATE_SCHEMA = STATE_SCHEMA_EPOCH;

export interface ResolvedInstallerPaths extends InstallerPaths {
  readonly stateRoot: string;
  readonly activeRecord: string;
  readonly journal: string;
  readonly lock: string;
  readonly marketplaceFile: string;
  readonly marketplacePlugins: string;
  readonly payloadRoot: string;
  readonly stagingRoot: string;
  readonly runsRoot: string;
}

export function resolveInstallerPaths(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedInstallerPaths {
  const home = homedir();
  const codexHome = options.paths?.codexHome ?? environment["CODEX_HOME"] ?? join(home, ".codex");
  const marketplaceRoot =
    options.paths?.marketplaceRoot ??
    environment["HOLYCODEX_MARKETPLACE_ROOT"] ??
    join(home, ".agents", "plugins");
  const safeCodexHome = assertRootText(codexHome, "CODEX_HOME");
  const safeMarketplaceRoot = assertRootText(marketplaceRoot, "marketplace root");
  if (
    safeCodexHome === safeMarketplaceRoot ||
    pathWithin(safeCodexHome, safeMarketplaceRoot) ||
    pathWithin(safeMarketplaceRoot, safeCodexHome)
  ) {
    throw new PathBoundaryError(
      "unsafe_root_alias",
      "CODEX_HOME and marketplace root must differ.",
    );
  }
  const stateRoot = join(safeCodexHome, STATE_ROOT_NAME);
  const marketplacePlugins = join(safeMarketplaceRoot, "plugins", PAYLOAD_DIRECTORY_NAME);
  return {
    codexHome: safeCodexHome,
    marketplaceRoot: safeMarketplaceRoot,
    stateRoot,
    activeRecord: join(stateRoot, ACTIVE_RECORD_NAME),
    journal: join(stateRoot, JOURNAL_NAME),
    lock: join(safeCodexHome, LOCK_NAME),
    marketplaceFile: join(safeMarketplaceRoot, "marketplace.json"),
    marketplacePlugins,
    payloadRoot: marketplacePlugins,
    stagingRoot: join(safeMarketplaceRoot, "plugins", ".holycodex-staging"),
    runsRoot: join(stateRoot, "runs"),
  };
}

export class PathBoundaryError extends Error {
  readonly code: "invalid_path" | "unsafe_root_alias" | "path_symlink" | "broad_path";

  constructor(
    code: "invalid_path" | "unsafe_root_alias" | "path_symlink" | "broad_path",
    message: string,
  ) {
    super(message);
    this.name = "PathBoundaryError";
    this.code = code;
  }
}

export function assertRootText(
  value: string,
  label: string,
  platform: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix",
): string {
  const api = platform === "win32" ? win32 : posix;
  const candidate = normalizePlatformPath(value, platform);
  if (typeof candidate !== "string" || candidate.length === 0 || !api.isAbsolute(candidate)) {
    throw new PathBoundaryError("invalid_path", `${label} must be an absolute path.`);
  }
  const normalized = api.normalize(candidate);
  const segments = normalized
    .split(platform === "win32" ? "\\" : sep)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || normalized === api.dirname(normalized)) {
    throw new PathBoundaryError("broad_path", `${label} is too broad.`);
  }
  if (candidate.split(/[\\/]/u).some((segment) => segment === "..")) {
    throw new PathBoundaryError("invalid_path", `${label} cannot contain traversal.`);
  }
  return api.resolve(normalized);
}

export async function ensureOwnedDirectory(path: string): Promise<void> {
  assertRootText(path, "owned path");
  await mkdir(path, { recursive: true });
  await assertNoSymlink(path);
}

export async function assertNoSymlink(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new PathBoundaryError("path_symlink", "A managed path cannot contain a symlink.");
      }
      break;
    } catch (error: unknown) {
      if (error instanceof PathBoundaryError) {
        throw error;
      }
      if (isFsCode(error, "ENOENT")) {
        missing.push(current);
        const parent = dirname(current);
        if (parent === current) {
          throw new PathBoundaryError("invalid_path", "The managed path has no existing parent.");
        }
        current = parent;
        continue;
      }
      throw error;
    }
  }
  void missing;
}

export async function assertNoSymlinkTree(path: string): Promise<void> {
  await assertNoSymlink(path);
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (canonical !== resolve(path)) {
    throw new PathBoundaryError("path_symlink", "A managed path resolves through an alias.");
  }
}

export function pathWithin(
  root: string,
  child: string,
  platform: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix",
): boolean {
  const api = platform === "win32" ? win32 : posix;
  const rootPath = api.resolve(normalizePlatformPath(root, platform));
  const childPath = api.resolve(normalizePlatformPath(child, platform));
  const remainder = api.relative(rootPath, childPath);
  return (
    remainder.length > 0 &&
    !remainder.startsWith(`..${platform === "win32" ? "\\" : sep}`) &&
    remainder !== ".." &&
    !api.isAbsolute(remainder)
  );
}

function normalizePlatformPath(value: string, platform: "posix" | "win32"): string {
  if (platform === "win32" && /^\/[A-Za-z](?:\/|$)/u.test(value)) {
    return `${value[1]?.toUpperCase() ?? ""}:${value.slice(2).replaceAll("/", "\\")}`;
  }
  return value;
}

export function isFsCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
