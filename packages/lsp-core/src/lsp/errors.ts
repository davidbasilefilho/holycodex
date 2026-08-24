// SPDX-License-Identifier: Apache-2.0

export type LspErrorCode =
  | "connection_closed"
  | "process_exited"
  | "request_timeout"
  | "invalid_path"
  | "server_lookup"
  | "server_initializing"
  | "process_spawn"
  | "protocol"
  | "setup_required"
  | "setup_owned_path";

export class LspError extends Error {
  readonly code: LspErrorCode;
  constructor(code: LspErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LspError";
    this.code = code;
  }
}

export class LspConnectionClosedError extends LspError {
  constructor(
    readonly serverId: string,
    readonly root: string,
    message?: string,
  ) {
    super("connection_closed", message ?? `LSP connection closed for ${serverId} at ${root}`);
    this.name = "LspConnectionClosedError";
  }
}

export class LspProcessExitedError extends LspError {
  constructor(
    readonly serverId: string,
    readonly root: string,
    readonly exitCode: number | null,
    readonly stderrTail?: string,
  ) {
    super(
      "process_exited",
      `LSP server ${serverId} at ${root} exited with code ${exitCode ?? "null"}${stderrTail ? `\nstderr tail: ${stderrTail}` : ""}`,
    );
    this.name = "LspProcessExitedError";
  }
}

export class LspRequestTimeoutError extends LspError {
  constructor(
    readonly method: string,
    readonly stderrTail?: string,
  ) {
    super(
      "request_timeout",
      `LSP request timeout (method: ${method})${stderrTail ? `\nrecent stderr: ${stderrTail}` : ""}`,
    );
    this.name = "LspRequestTimeoutError";
  }
}

export class LspInvalidPathError extends LspError {
  constructor(message: string) {
    super("invalid_path", message);
    this.name = "LspInvalidPathError";
  }
}

export class LspServerLookupError extends LspError {
  constructor(message: string) {
    super("server_lookup", message);
    this.name = "LspServerLookupError";
  }
}

export class LspServerInitializingError extends LspError {
  constructor(readonly originalError: LspRequestTimeoutError) {
    super(
      "server_initializing",
      `LSP server is still initializing. Please retry in a few seconds. Original error: ${originalError.message}`,
    );
    this.name = "LspServerInitializingError";
  }
}

export class LspProcessSpawnError extends LspError {
  constructor(message: string) {
    super("process_spawn", message);
    this.name = "LspProcessSpawnError";
  }
}

export class LspSetupError extends LspError {
  constructor(code: "setup_required" | "setup_owned_path", message: string) {
    super(code, message);
    this.name = "LspSetupError";
  }
}

export function isLspDeadConnectionError(
  error: unknown,
): error is LspConnectionClosedError | LspProcessExitedError {
  return error instanceof LspConnectionClosedError || error instanceof LspProcessExitedError;
}

export function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
