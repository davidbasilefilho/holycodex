// SPDX-License-Identifier: Apache-2.0

import { withLspClient } from "../lsp/client-wrapper.ts";
import { formatApplyResult, formatPrepareRenameResult } from "../lsp/formatters.ts";
import { applyWorkspaceEdit } from "../lsp/workspace-edit.ts";
import { missingDependencyResultOrThrow } from "../missing-dependency-result.ts";
import { requireString, sourcePosition } from "./parameters.ts";
import { text } from "./result.ts";
/** Executes semantic rename preparation. */
export async function executeLspPrepareRename(
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const position = sourcePosition(params);
  try {
    const result = await withLspClient(
      position.filePath,
      (client) =>
        client.prepareRename(position.filePath, position.line, position.character, signal),
      "prepareRename",
      { signal },
    );
    return text(formatPrepareRenameResult(result), { ...position, result });
  } catch (error: unknown) {
    return missingDependencyResultOrThrow(error, { ...position, result: null });
  }
}
/** Executes rename and applies only workspace-confined edits. */
export async function executeLspRename(params: Record<string, unknown>, signal?: AbortSignal) {
  const position = sourcePosition(params);
  const newName = requireString(params, "newName");
  try {
    const value = await withLspClient(
      position.filePath,
      async (client, workspaceRoot) => ({
        edit: await client.rename(
          position.filePath,
          position.line,
          position.character,
          newName,
          signal,
        ),
        workspaceRoot,
      }),
      "rename",
      { signal },
    );
    const apply = applyWorkspaceEdit(value.edit, { workspaceRoot: value.workspaceRoot });
    return text(
      formatApplyResult(apply),
      { ...position, newName, apply, edit: value.edit },
      !apply.success,
    );
  } catch (error: unknown) {
    return missingDependencyResultOrThrow(error, { ...position, newName, apply: null, edit: null });
  }
}
