// SPDX-License-Identifier: Apache-2.0

import { withLspClient } from "../lsp/client-wrapper.ts";
import { DEFAULT_MAX_REFERENCES } from "../lsp/constants.ts";
import { formatLocation } from "../lsp/formatters.ts";
import { missingDependencyResultOrThrow } from "../missing-dependency-result.ts";
import { optionalBoolean, sourcePosition } from "./parameters.ts";
import { text } from "./result.ts";
import type {
  LspFindReferencesDetails,
  LspGotoDefinitionDetails,
  ToolExecutionResult,
} from "./types.ts";

/** Executes go-to-definition. */
export async function executeLspGotoDefinition(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const position = sourcePosition(params);
  try {
    const value = await withLspClient(
      position.filePath,
      (client) => client.definition(position.filePath, position.line, position.character, signal),
      "definition",
      { signal },
    );
    const locations = value === null ? [] : Array.isArray(value) ? [...value] : [value];
    const details: LspGotoDefinitionDetails = { ...position, locations };
    return text(
      locations.length === 0 ? "No definition found" : locations.map(formatLocation).join("\n"),
      details,
    );
  } catch (error: unknown) {
    return missingDependencyResultOrThrow(error, { ...position, locations: [] });
  }
}
/** Executes go-to-declaration. */
export async function executeLspGotoDeclaration(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const position = sourcePosition(params);
  try {
    const value = await withLspClient(
      position.filePath,
      (client) => client.declaration(position.filePath, position.line, position.character, signal),
      "declaration",
      { signal },
    );
    const locations = value === null ? [] : Array.isArray(value) ? [...value] : [value];
    return text(
      locations.length === 0 ? "No declaration found" : locations.map(formatLocation).join("\n"),
      { ...position, locations },
    );
  } catch (error: unknown) {
    return missingDependencyResultOrThrow(error, { ...position, locations: [] });
  }
}
/** Executes find-references with the legacy bounded output contract. */
export async function executeLspFindReferences(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const position = sourcePosition(params);
  const includeDeclaration = optionalBoolean(params, "includeDeclaration") ?? true;
  try {
    const references = [
      ...(await withLspClient(
        position.filePath,
        (client) =>
          client.references(
            position.filePath,
            position.line,
            position.character,
            includeDeclaration,
            signal,
          ),
        "references",
        { signal },
      )),
    ];
    const total = references.length;
    const details: LspFindReferencesDetails = {
      ...position,
      references,
      totalReferences: total,
      truncated: total > DEFAULT_MAX_REFERENCES,
    };
    const shown = references.slice(0, DEFAULT_MAX_REFERENCES);
    return text(
      total === 0 ? "No references found" : shown.map(formatLocation).join("\n"),
      details,
    );
  } catch (error: unknown) {
    return missingDependencyResultOrThrow(error, {
      ...position,
      references: [],
      totalReferences: 0,
      truncated: false,
    });
  }
}
