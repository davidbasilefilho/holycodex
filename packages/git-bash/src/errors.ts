// SPDX-License-Identifier: Apache-2.0

export type GitBashErrorCode =
  | "invalid_input"
  | "unavailable"
  | "unsafe_executable"
  | "launch_failed";

export type GitBashErrorDetails = Readonly<Record<string, string | number | boolean>>;

export class GitBashError extends Error {
  readonly code: GitBashErrorCode;
  readonly details: GitBashErrorDetails;

  constructor(
    code: GitBashErrorCode,
    message: string,
    details: GitBashErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitBashError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }
}

export function isGitBashError(value: unknown): value is GitBashError {
  return value instanceof GitBashError;
}
