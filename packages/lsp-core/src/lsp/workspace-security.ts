// SPDX-License-Identifier: Apache-2.0

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LspInvalidPathError } from "./errors.ts";

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function realPathForValidation(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return resolve(realpathSync(parent), path.slice(parent.length));
}

/** Resolves a workspace path and rejects traversal and symlink/reparse escapes. */
export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = realpathSync(workspaceRoot);
  const candidate = resolve(workspaceRoot, inputPath);
  const validated = realPathForValidation(candidate);
  if (!inside(root, validated))
    throw new LspInvalidPathError(`Path escapes workspace root: ${inputPath}`);
  return candidate;
}

/** Converts a file URI into a path confined to a workspace. */
export function fileUriToWorkspacePath(uri: string, workspaceRoot: string): string {
  let path: string;
  try {
    path = fileURLToPath(uri);
  } catch (error: unknown) {
    throw new LspInvalidPathError(
      `Invalid file URI '${uri}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return resolveWorkspacePath(workspaceRoot, path);
}

/** Validates an existing workspace directory without following an escaping link. */
export function validateWorkspaceRoot(root: string): string {
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return realpathSync(root);
  } catch (error: unknown) {
    throw new LspInvalidPathError(
      `Workspace root is unavailable: ${root} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
