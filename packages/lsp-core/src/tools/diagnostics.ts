// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { aggregateDiagnosticsForDirectory } from "../lsp/directory-diagnostics.ts";
import { DEFAULT_MAX_DIAGNOSTICS } from "../lsp/constants.ts";
import { filterDiagnosticsBySeverity, formatDiagnostic } from "../lsp/formatters.ts";
import { isDirectoryPath, withLspClient } from "../lsp/client-wrapper.ts";
import { inferExtensionFromDirectory } from "../lsp/infer-extension.ts";
import { contextCwd } from "../request-context.ts";
import { missingDependencyResultOrThrow } from "../missing-dependency-result.ts";
import { requireString, severityFilter } from "./parameters.ts";
import { text } from "./result.ts";
import type { LspDiagnosticsDetails, ToolExecutionResult } from "./types.ts";

/** Executes file or bounded directory diagnostics. */
export async function executeLspDiagnostics(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const filePath = requireString(params, "filePath");
  const severity = severityFilter(params);
  const absolute = resolve(contextCwd(), filePath);
  if (isDirectoryPath(absolute)) {
    const extension = inferExtensionFromDirectory(absolute);
    if (extension === null)
      return text(`No supported source files found in directory: ${absolute}`, {
        filePath,
        severity,
        mode: "directory",
        diagnostics: [],
        totalDiagnostics: 0,
        truncated: false,
        errorKind: "no_files",
      });
    try {
      return text(await aggregateDiagnosticsForDirectory(absolute, extension, severity), {
        filePath,
        severity,
        mode: "directory",
        diagnostics: [],
        totalDiagnostics: 0,
        truncated: false,
      });
    } catch (error: unknown) {
      return missingDependencyResultOrThrow(error, {
        filePath,
        severity,
        mode: "directory",
        diagnostics: [],
        totalDiagnostics: 0,
        truncated: false,
      });
    }
  }
  try {
    const result = await withLspClient(
      filePath,
      async (client) => client.diagnostics(filePath, signal),
      "diagnostics",
      { signal },
    );
    const diagnostics = filterDiagnosticsBySeverity(result.items, severity);
    const total = diagnostics.length;
    const shown = diagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS);
    const details: LspDiagnosticsDetails = {
      filePath,
      severity,
      mode: "file",
      diagnostics: diagnostics.map((diagnostic) => ({ file: absolute, diagnostic })),
      totalDiagnostics: total,
      truncated: total > shown.length,
    };
    return text(
      total === 0 ? "No diagnostics found" : shown.map(formatDiagnostic).join("\n"),
      details,
    );
  } catch (error: unknown) {
    return missingDependencyResultOrThrow(error, {
      filePath,
      severity,
      mode: "file",
      diagnostics: [],
      totalDiagnostics: 0,
      truncated: false,
    });
  }
}
