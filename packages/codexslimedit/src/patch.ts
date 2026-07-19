import { WorkspaceFileError } from "./errors.js";
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "./workspace.js";

/** Input for a Codex-compatible workspace patch envelope. */
export interface ApplyWorkspacePatchInput {
  /** Workspace root used to constrain file access. */
  readonly root: string;
  /** Codex `*** Begin Patch` envelope. */
  readonly patch: string;
}

/** Paths changed by a workspace patch. */
export interface WorkspacePatchResult {
  /** Canonical root-relative paths in patch order. */
  readonly paths: readonly string[];
}

interface AddOperation {
  readonly kind: "add";
  readonly filePath: string;
  readonly content: string;
}

interface DeleteOperation {
  readonly kind: "delete";
  readonly filePath: string;
}

interface UpdateOperation {
  readonly kind: "update";
  readonly filePath: string;
  readonly hunks: readonly UpdateHunk[];
}

interface UpdateHunk {
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}

type PatchOperation = AddOperation | DeleteOperation | UpdateOperation;

/** Applies Codex add, update, and delete patch operations inside a workspace. */
export async function applyWorkspacePatch(
  input: ApplyWorkspacePatchInput,
): Promise<WorkspacePatchResult> {
  const operations = parsePatch(input.patch);
  const paths: string[] = [];
  for (const operation of operations) {
    if (operation.kind === "add") {
      const result = await createWorkspaceFile({
        root: input.root,
        filePath: operation.filePath,
        content: operation.content,
      });
      paths.push(result.path);
      continue;
    }
    if (operation.kind === "delete") {
      const result = await deleteWorkspaceFile({ root: input.root, filePath: operation.filePath });
      paths.push(result.path);
      continue;
    }
    const current = await readWorkspaceFile({ root: input.root, filePath: operation.filePath });
    const result = await writeWorkspaceFile({
      root: input.root,
      filePath: operation.filePath,
      content: applyUpdateHunks(current.content, operation.hunks),
    });
    paths.push(result.path);
  }
  return { paths };
}

function parsePatch(patch: string): readonly PatchOperation[] {
  const lines = patch.replace(/\r\n|\r/g, "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    invalidPatch("Patch must start with `*** Begin Patch` and end with `*** End Patch`.");
  }
  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const header = lines[index];
    const addPath = header?.match(/^\*\*\* Add File: (.+)$/)?.[1];
    const updatePath = header?.match(/^\*\*\* Update File: (.+)$/)?.[1];
    const deletePath = header?.match(/^\*\*\* Delete File: (.+)$/)?.[1];
    index += 1;
    if (addPath !== undefined) {
      const contentLines: string[] = [];
      while (index < lines.length - 1 && !lines[index]?.startsWith("*** ")) {
        const line = lines[index];
        if (!line?.startsWith("+")) invalidPatch("Add File lines must start with `+`.");
        contentLines.push(line.slice(1));
        index += 1;
      }
      operations.push({
        kind: "add",
        filePath: filePath(addPath),
        content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
      });
      continue;
    }
    if (deletePath !== undefined) {
      operations.push({ kind: "delete", filePath: filePath(deletePath) });
      continue;
    }
    if (updatePath !== undefined) {
      const hunks: UpdateHunk[] = [];
      let oldLines: string[] | undefined;
      let newLines: string[] | undefined;
      while (index < lines.length - 1 && !lines[index]?.startsWith("*** ")) {
        const line = lines[index];
        if (line?.startsWith("@@")) {
          if (oldLines !== undefined && newLines !== undefined) {
            hunks.push(validHunk(oldLines, newLines));
          }
          oldLines = [];
          newLines = [];
          index += 1;
          continue;
        }
        if (oldLines === undefined || newLines === undefined || line === undefined) {
          invalidPatch("Update File content must begin with an `@@` hunk header.");
        }
        const prefix = line[0];
        const content = line.slice(1);
        if (prefix === " " || prefix === "-") oldLines.push(content);
        if (prefix === " " || prefix === "+") newLines.push(content);
        if (prefix !== " " && prefix !== "-" && prefix !== "+") {
          invalidPatch("Update hunk lines must start with a space, `-`, or `+`.");
        }
        index += 1;
      }
      if (oldLines !== undefined && newLines !== undefined) {
        hunks.push(validHunk(oldLines, newLines));
      }
      if (hunks.length === 0) invalidPatch("Update File requires at least one hunk.");
      operations.push({ kind: "update", filePath: filePath(updatePath), hunks });
      continue;
    }
    invalidPatch(`Unknown patch operation: ${header ?? "<missing>"}`);
  }
  if (operations.length === 0) invalidPatch("Patch must contain at least one file operation.");
  return operations;
}

function validHunk(oldLines: string[], newLines: string[]): UpdateHunk {
  if (oldLines.length === 0) {
    invalidPatch("Update hunks require old or context lines for deterministic placement.");
  }
  return { oldLines, newLines };
}

function applyUpdateHunks(content: string, hunks: readonly UpdateHunk[]): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n|\r/g, "\n");
  const hasFinalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hasFinalNewline) lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    const offset = uniqueSequenceOffset(lines, hunk.oldLines, cursor);
    lines.splice(offset, hunk.oldLines.length, ...hunk.newLines);
    cursor = offset + hunk.newLines.length;
  }
  if (lines.length === 0) return "";
  return `${lines.join(lineEnding)}${hasFinalNewline ? lineEnding : ""}`;
}

function uniqueSequenceOffset(
  lines: readonly string[],
  expected: readonly string[],
  cursor: number,
): number {
  const offsets: number[] = [];
  for (let offset = cursor; offset <= lines.length - expected.length; offset += 1) {
    if (expected.every((line, index) => lines[offset + index] === line)) offsets.push(offset);
  }
  if (offsets.length === 1) return offsets[0] ?? 0;
  if (offsets.length > 1) {
    throw new WorkspaceFileError(
      "DUPLICATE_MATCH",
      "Patch hunk matches more than once; include more unchanged context.",
    );
  }
  throw new WorkspaceFileError(
    "EXACT_MATCH_NOT_FOUND",
    "Patch hunk context was not found exactly.",
  );
}

function filePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") invalidPatch("Patch file paths must not be empty.");
  return trimmed;
}

function invalidPatch(message: string): never {
  throw new WorkspaceFileError("INVALID_PATCH", message);
}
