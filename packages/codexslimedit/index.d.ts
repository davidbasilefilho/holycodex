import type { Readable, Writable } from "node:stream";

/** Current independent codexslimedit package version. */
export declare const CODEX_SLIM_EDIT_VERSION = "0.1.0";

/** Returns whether command-line arguments request the package version. */
export declare function isVersionRequest(args: readonly string[]): boolean;

/** Identifies a workspace file operation failure. */
export type WorkspaceFileErrorCode =
  | "ALREADY_EXISTS"
  | "EXACT_MATCH_NOT_FOUND"
  | "DUPLICATE_MATCH"
  | "INVALID_PATCH"
  | "INVALID_RANGE"
  | "NOT_A_FILE"
  | "NOT_FOUND"
  | "PATH_OUTSIDE_ROOT"
  | "UNREADABLE_FILE"
  | "UNSUPPORTED_TEXT"
  | "WRITE_FAILED";

/** Reports a typed, actionable workspace file operation failure. */
export declare class WorkspaceFileError extends Error {
  /** Creates a workspace file operation error. */
  constructor(code: WorkspaceFileErrorCode, message: string);
  readonly code: WorkspaceFileErrorCode;
}

/** Input shared by workspace file operations. */
export interface WorkspaceFileInput {
  /** Workspace root used to constrain file access. */
  readonly root: string;
  /** Relative path to the target file. */
  readonly filePath: string;
}

/** Input for an exact-content or inclusive-line-range edit. */
export interface EditWorkspaceFileInput extends WorkspaceFileInput {
  /** Exact text to replace, or an inclusive 1-based `N` or `N-M` line range. */
  readonly oldString: string;
  /** Replacement text. */
  readonly newString: string;
}

/** Content returned by a workspace file operation. */
export interface WorkspaceFileResult {
  /** Canonical root-relative path. */
  readonly path: string;
  /** UTF-8 file content after the operation. */
  readonly content: string;
}

/** Input for writing complete UTF-8 content to a workspace file. */
export interface WriteWorkspaceFileInput extends WorkspaceFileInput {
  /** Complete replacement content. */
  readonly content: string;
}

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

/** Options for the CodexSlimEdit MCP server. */
export interface CodexSlimEditMcpOptions {
  /** Workspace root; defaults to the server process current directory. */
  readonly root?: string;
}

/** Reads a regular UTF-8 text file inside the workspace root. */
export declare function readWorkspaceFile(input: WorkspaceFileInput): Promise<WorkspaceFileResult>;

/** Applies one validated exact-content or inclusive-line-range edit atomically. */
export declare function editWorkspaceFile(
  input: EditWorkspaceFileInput,
): Promise<WorkspaceFileResult>;

/** Replaces an existing workspace file with complete UTF-8 content. */
export declare function writeWorkspaceFile(
  input: WriteWorkspaceFileInput,
): Promise<WorkspaceFileResult>;

/** Creates a new workspace file in an existing directory. */
export declare function createWorkspaceFile(
  input: WriteWorkspaceFileInput,
): Promise<WorkspaceFileResult>;

/** Deletes one existing regular workspace file. */
export declare function deleteWorkspaceFile(
  input: WorkspaceFileInput,
): Promise<WorkspaceFileResult>;

/** Applies Codex add, update, and delete patch operations inside a workspace. */
export declare function applyWorkspacePatch(
  input: ApplyWorkspacePatchInput,
): Promise<WorkspacePatchResult>;

/** Handles one CodexSlimEdit MCP JSON-RPC request. */
export declare function handleCodexSlimEditMcpRequest(
  input: unknown,
  options?: CodexSlimEditMcpOptions,
): Promise<unknown>;

/** Runs the CodexSlimEdit MCP server over stdio. */
export declare function runCodexSlimEditMcpStdioServer(
  input: Readable,
  output: Writable,
  options?: CodexSlimEditMcpOptions,
): Promise<void>;
