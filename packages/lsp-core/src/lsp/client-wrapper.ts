// SPDX-License-Identifier: Apache-2.0

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { contextCwd } from "../request-context.ts";
import { effectiveExtension } from "./effective-extension.ts";
import { findServerForExtension, formatServerLookupError } from "./server-resolution.ts";
import { getLspManager, type LspManager } from "./manager.ts";
import {
  isLspDeadConnectionError,
  LspInvalidPathError,
  LspRequestTimeoutError,
  LspServerInitializingError,
  LspServerLookupError,
} from "./errors.ts";
import type { LspClient } from "./client.ts";

const markers = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
];

/** Finds a workspace root by walking from a source file or directory marker. */
export function findWorkspaceRoot(filePath: string): string {
  const absolute = resolve(contextCwd(), filePath);
  let directory = isDirectoryPath(absolute) ? absolute : dirname(absolute);
  let previous = "";
  while (directory !== previous) {
    if (markers.some((marker) => existsSync(join(directory, marker)))) return directory;
    previous = directory;
    directory = dirname(directory);
  }
  return dirname(absolute);
}

export function isDirectoryPath(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export interface WithLspClientOptions {
  readonly signal?: AbortSignal | undefined;
  readonly manager?: LspManager | undefined;
}

const retryable = new Set([
  "diagnostics",
  "definition",
  "declaration",
  "references",
  "documentSymbols",
  "workspaceSymbols",
  "prepareRename",
]);

/** Resolves, initializes, and releases an LSP client for one confined workspace. */
export async function withLspClient<T>(
  filePath: string,
  fn: (client: LspClient, workspaceRoot: string) => Promise<T>,
  toolName: string,
  options: WithLspClientOptions = {},
): Promise<T> {
  const absolute = resolve(contextCwd(), filePath);
  if (isDirectoryPath(absolute))
    throw new LspInvalidPathError("Directory paths are not supported by this LSP tool.");
  const lookup = findServerForExtension(effectiveExtension(absolute));
  if (lookup.status !== "found") throw new LspServerLookupError(formatServerLookupError(lookup));
  const root = findWorkspaceRoot(absolute);
  const manager = options.manager ?? getLspManager();
  const call = async (allowRetry: boolean): Promise<T> => {
    const client = await manager.getClient(root, lookup.server, options.signal);
    try {
      return await fn(client, root);
    } catch (error: unknown) {
      if (allowRetry && retryable.has(toolName) && isLspDeadConnectionError(error)) {
        manager.invalidateClient(root, lookup.server.id, client);
        return call(false);
      }
      if (
        error instanceof LspRequestTimeoutError &&
        manager.isServerInitializing(root, lookup.server.id)
      )
        throw new LspServerInitializingError(error);
      throw error;
    } finally {
      manager.releaseClient(root, lookup.server.id);
    }
  };
  return call(true);
}
