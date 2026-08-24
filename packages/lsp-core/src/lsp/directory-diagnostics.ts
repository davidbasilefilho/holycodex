// SPDX-License-Identifier: Apache-2.0

import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { contextCwd } from "../request-context.ts";
import { DEFAULT_MAX_DIAGNOSTICS, DEFAULT_MAX_DIRECTORY_FILES } from "./constants.ts";
import { effectiveExtension } from "./effective-extension.ts";
import { findWorkspaceRoot } from "./client-wrapper.ts";
import { getLspManager } from "./manager.ts";
import { filterDiagnosticsBySeverity, formatDiagnostic } from "./formatters.ts";
import { findServerForExtension } from "./server-resolution.ts";
import type { Diagnostic, SeverityFilter } from "./types.ts";

const skipped = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "target",
  ".venv",
  "venv",
  "vendor",
  "coverage",
]);

/** Collects bounded non-symlink files with an exact effective extension. */
export function collectFilesWithExtension(
  directory: string,
  extension: string,
  maxFiles: number,
): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    if (files.length >= maxFiles) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const path = join(current, entry);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (!skipped.has(entry)) walk(path);
        } else if (stat.isFile() && effectiveExtension(path) === extension) files.push(path);
      } catch {
        /* inaccessible entries are skipped */
      }
    }
  };
  walk(directory);
  return files;
}

/** Runs diagnostics over a bounded directory file set through one pooled client. */
export async function aggregateDiagnosticsForDirectory(
  directory: string,
  extension: string,
  severity: SeverityFilter = "all",
  maxFiles = DEFAULT_MAX_DIRECTORY_FILES,
): Promise<string> {
  if (!extension.startsWith(".")) throw new Error(`Extension must start with a dot: ${extension}`);
  const absolute = resolve(contextCwd(), directory);
  const files = collectFilesWithExtension(absolute, extension, maxFiles + 1);
  const capped = files.length > maxFiles;
  const selected = files.slice(0, maxFiles);
  if (selected.length === 0)
    return [
      `Directory: ${absolute}`,
      `Extension: ${extension}`,
      "Files scanned: 0",
      `No files found with extension "${extension}".`,
    ].join("\n");
  const manager = getLspManager();
  const server = findServerForExtension(extension);
  if (server.status !== "found") throw new Error(`No installed LSP server for ${extension}.`);
  const client = await manager.getClient(findWorkspaceRoot(absolute), server.server);
  const diagnostics: Array<{ readonly file: string; readonly diagnostic: Diagnostic }> = [];
  try {
    for (const file of selected) {
      try {
        diagnostics.push(
          ...filterDiagnosticsBySeverity((await client.diagnostics(file)).items, severity).map(
            (diagnostic) => ({ file, diagnostic }),
          ),
        );
      } catch {
        /* one file must not abort the directory scan */
      }
    }
  } finally {
    manager.releaseClient(findWorkspaceRoot(absolute), server.server.id);
  }
  const shown = diagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS);
  return [
    `Directory: ${absolute}`,
    `Extension: ${extension}`,
    `Files scanned: ${selected.length}${capped ? ` (capped at ${maxFiles})` : ""}`,
    `Total diagnostics: ${diagnostics.length}`,
    ...(shown.length === 0
      ? []
      : ["", ...shown.map((entry) => `${entry.file}: ${formatDiagnostic(entry.diagnostic)}`)]),
    ...(diagnostics.length > shown.length
      ? ["", `... (${diagnostics.length - shown.length} more diagnostics not shown)`]
      : []),
  ].join("\n");
}
