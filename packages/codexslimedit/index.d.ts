import type { Readable, Writable } from "node:stream";

/** Current independent codexslimedit package version. */
export declare const CODEX_SLIM_EDIT_VERSION = "0.1.0";

/** Returns whether command-line arguments request the package version. */
export declare function isVersionRequest(args: readonly string[]): boolean;

/** Identifies a workspace file operation failure. */
export type WorkspaceFileErrorCode =
  | "EXACT_MATCH_NOT_FOUND"
  | "DUPLICATE_MATCH"
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
