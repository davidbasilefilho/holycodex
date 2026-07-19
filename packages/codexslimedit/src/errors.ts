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
export class WorkspaceFileError extends Error {
  /** Creates a workspace file operation error. */
  constructor(
    readonly code: WorkspaceFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}
