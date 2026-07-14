import { formatApplyResult, formatPrepareRenameResult } from "../lsp/formatters.js";
import { withLspClient } from "../lsp/client-wrapper.js";
import { applyWorkspaceEdit } from "../lsp/workspace-edit.js";
import { missingDependencyResultOrThrow } from "../missing-dependency-result.js";
import { clientOptions, requireString, sourcePosition } from "./parameters.js";
import { text } from "./result.js";
import type { LspPrepareRenameDetails, LspRenameDetails, ToolExecutionResult } from "./types.js";

export async function executeLspPrepareRename(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const { filePath, line, character } = sourcePosition(params);

  try {
    const result = await withLspClient(
      filePath,
      async (client) => client.prepareRename(filePath, line, character),
      "prepareRename",
      clientOptions(signal),
    );
    const details: LspPrepareRenameDetails = { filePath, line, character, result };
    return text(formatPrepareRenameResult(result), details);
  } catch (error) {
    return missingDependencyResultOrThrow(error, {
      filePath,
      line,
      character,
      result: null,
    } satisfies Omit<LspPrepareRenameDetails, "error" | "errorKind">);
  }
}

export async function executeLspRename(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const { filePath, line, character } = sourcePosition(params);
  const newName = requireString(params, "newName");

  try {
    const edit = await withLspClient(
      filePath,
      async (client, workspaceRoot) => ({
        edit: await client.rename(filePath, line, character, newName),
        workspaceRoot,
      }),
      "rename",
      clientOptions(signal),
    );
    const apply = applyWorkspaceEdit(edit.edit, { workspaceRoot: edit.workspaceRoot });
    const details: LspRenameDetails = {
      filePath,
      line,
      character,
      newName,
      apply,
      edit: edit.edit,
    };
    return text(formatApplyResult(apply), details, !apply.success);
  } catch (error) {
    return missingDependencyResultOrThrow(error, {
      filePath,
      line,
      character,
      newName,
      apply: null,
      edit: null,
    } satisfies Omit<LspRenameDetails, "error" | "errorKind">);
  }
}
