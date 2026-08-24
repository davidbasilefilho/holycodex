// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { fileUriToWorkspacePath } from "./workspace-security.ts";
import type { TextEdit, WorkspaceEdit } from "./types.ts";

export interface ApplyResult {
  readonly success: boolean;
  readonly filesModified: readonly string[];
  readonly totalEdits: number;
  readonly errors: readonly string[];
}
export interface ApplyWorkspaceEditOptions {
  readonly workspaceRoot?: string;
}

function applyTextEdits(
  path: string,
  edits: readonly TextEdit[],
): { readonly ok: true; readonly count: number } | { readonly ok: false; readonly error: string } {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const sorted = [...edits].sort(
      (a, b) =>
        b.range.start.line - a.range.start.line ||
        b.range.start.character - a.range.start.character,
    );
    for (const edit of sorted) {
      const start = edit.range.start;
      const end = edit.range.end;
      if (start.line < 0 || end.line < start.line || start.character < 0 || end.character < 0)
        return { ok: false, error: "invalid text edit range" };
      const first = lines[start.line] ?? "";
      const last = lines[end.line] ?? "";
      if (start.line === end.line)
        lines[start.line] =
          first.slice(0, start.character) + edit.newText + first.slice(end.character);
      else
        lines.splice(
          start.line,
          end.line - start.line + 1,
          ...(first.slice(0, start.character) + edit.newText + last.slice(end.character)).split(
            "\n",
          ),
        );
    }
    writeFileSync(path, lines.join("\n"), "utf8");
    return { ok: true, count: edits.length };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Applies LSP workspace edits only after every target has passed workspace confinement. */
export function applyWorkspaceEdit(
  edit: WorkspaceEdit | null,
  options: ApplyWorkspaceEditOptions = {},
): ApplyResult {
  if (edit === null)
    return { success: false, filesModified: [], totalEdits: 0, errors: ["No edit provided"] };
  const workspaceRoot = realpathSync(options.workspaceRoot ?? process.cwd());
  const modified: string[] = [];
  const errors: string[] = [];
  let total = 0;
  const apply = (uri: string, edits: readonly TextEdit[]): void => {
    try {
      const path = fileUriToWorkspacePath(uri, workspaceRoot);
      const result = applyTextEdits(path, edits);
      if (result.ok) {
        modified.push(path);
        total += result.count;
      } else errors.push(`${path}: ${result.error}`);
    } catch (error: unknown) {
      errors.push(`${uri}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) apply(uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if (!("kind" in change)) {
      apply(change.textDocument.uri, change.edits);
      continue;
    }
    try {
      if (change.kind === "create") {
        const path = fileUriToWorkspacePath(change.uri, workspaceRoot);
        if (existsSync(path) && change.options?.ignoreIfExists !== true)
          throw new Error("target already exists");
        writeFileSync(path, "", "utf8");
        modified.push(path);
      } else if (change.kind === "rename") {
        const oldPath = fileUriToWorkspacePath(change.oldUri, workspaceRoot);
        const newPath = fileUriToWorkspacePath(change.newUri, workspaceRoot);
        if (existsSync(newPath) && change.options?.overwrite !== true)
          throw new Error("rename target already exists");
        writeFileSync(newPath, readFileSync(oldPath));
        unlinkSync(oldPath);
        modified.push(newPath);
      } else {
        const path = fileUriToWorkspacePath(change.uri, workspaceRoot);
        if (!existsSync(path) && change.options?.ignoreIfNotExists !== true)
          throw new Error("target does not exist");
        if (existsSync(path)) unlinkSync(path);
        modified.push(path);
      }
    } catch (error: unknown) {
      errors.push(`${change.kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { success: errors.length === 0, filesModified: modified, totalEdits: total, errors };
}
