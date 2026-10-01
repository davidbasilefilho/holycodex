// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import {
  CodexError,
  DEFAULT_MAX_DIAGNOSTIC_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  sanitizeText,
} from "./common";

/** Data contract for async line transport. */
export interface AsyncLineTransport {
  /** Read line in the async line transport contract. */
  readLine(): Promise<string | null>;
  /** Write line in the async line transport contract. */
  writeLine(line: string): Promise<void>;
  /** Close in the async line transport contract. */
  close(): Promise<void>;
}

/** Select the environment variables allowed for a Codex subprocess. */
export function allowlistedEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const allowed = ["PATH", "HOME", "USER", "CODEX_HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"];
  const output: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined && value.length > 0) {
      output[key] = value;
    }
  }
  return output;
}

/** Freeze the subprocess environment to the explicitly allowlisted variables. */
export function createAllowlistedEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  return Object.freeze(allowlistedEnvironment(source));
}

/** Read a byte stream while enforcing a maximum output size. */
export function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  return Effect.runPromise(readBoundedStreamEffect(stream, maxBytes));
}

function readBoundedStreamEffect(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Effect.Effect<Uint8Array, CodexError> {
  return Effect.gen(function* () {
    const reader = yield* Effect.try({
      try: () => stream.getReader(),
      catch: (error) =>
        new CodexError(
          "transport_failure",
          "A subprocess stream could not be read.",
          {},
          { cause: error },
        ),
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    const read = Effect.gen(function* () {
      while (true) {
        const result = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: (error) =>
            new CodexError(
              "transport_failure",
              "A subprocess stream could not be read.",
              {},
              { cause: error },
            ),
        });
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) {
          return yield* Effect.fail(
            new CodexError("invalid_transport_line", "A subprocess stream exceeded its limit."),
          );
        }
        chunks.push(result.value);
      }
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    });
    return yield* Effect.ensuring(
      read,
      Effect.sync(() => reader.releaseLock()),
    );
  });
}

/** Decode bytes as strict UTF-8 and report malformed transport data. */
export function decodeUtf8(bytes: Uint8Array, label: string): string {
  return Effect.runSync(
    Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: (error) =>
        new CodexError(
          "invalid_transport_line",
          `Invalid UTF-8 in ${label}.`,
          {},
          { cause: error },
        ),
    }),
  );
}

/** Redact credentials and bound a single diagnostic line. */
export function sanitizeDiagnostic(value: string): string {
  return sanitizeText(
    value
      .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
      .replace(
        /((?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*)[^\s,;]+/giu,
        "$1[redacted]",
      ),
    512,
  );
}

/** Redact and bound multiline subprocess diagnostics for safe reporting. */
export function sanitizeDiagnostics(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => sanitizeDiagnostic(line))
    .filter((line) => line.length > 0)
    .slice(0, 128);
}

/** Options for configuring bun stdio transport. */
export interface BunStdioTransportOptions {
  /** Executable path in the bun stdio transport options contract. */
  readonly executablePath: string;
  /** Working directory used to resolve relative paths. */
  readonly cwd?: string;
  /** Environment variables passed to the process. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Max line bytes in the bun stdio transport options contract. */
  readonly maxLineBytes?: number;
  /** Max diagnostic bytes in the bun stdio transport options contract. */
  readonly maxDiagnosticBytes?: number;
  /** Signal in the bun stdio transport options contract. */
  readonly signal?: AbortSignal;
}

/** Line transport that connects to a Codex process through Bun stdio streams. */
export class BunStdioTransport implements AsyncLineTransport {
  private readonly process: Bun.Subprocess;
  private readonly stdin: NonNullable<Exclude<Bun.Subprocess["stdin"], number>>;
  private readonly stdoutReader: ReadableStream<Uint8Array>;
  private readonly stderrStream: ReadableStream<Uint8Array>;
  private readonly maxLineBytes: number;
  private readonly maxDiagnosticBytes: number;
  private readonly lineDecoder = new TextDecoder("utf-8", { fatal: true });
  private readonly stderrDiagnostics: string[] = [];
  private stdoutBuffer = new Uint8Array(0);
  private readonly stderrFiber: Fiber.Fiber<void, never>;
  private closeEffect: Effect.Effect<void> | undefined;
  private closed = false;

  constructor(options: BunStdioTransportOptions) {
    if (!isAbsolute(options.executablePath)) {
      throw new CodexError("discovery_failed", "The Codex executable path must be absolute.");
    }
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxDiagnosticBytes = options.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
    if (this.maxLineBytes < 1 || this.maxDiagnosticBytes < 1) {
      throw new CodexError("invalid_external_data", "The transport bounds are invalid.");
    }
    this.process = Bun.spawn([options.executablePath, "app-server"], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: allowlistedEnvironment(options.environment),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (
      !(this.process.stdout instanceof ReadableStream) ||
      !(this.process.stderr instanceof ReadableStream)
    ) {
      throw new CodexError("transport_failure", "The Codex App Server did not expose stdio pipes.");
    }
    if (typeof this.process.stdin === "number" || this.process.stdin === undefined) {
      throw new CodexError("transport_failure", "The Codex App Server did not expose stdin.");
    }
    this.stdin = this.process.stdin;
    this.stdoutReader = this.process.stdout;
    this.stderrStream = this.process.stderr;
    this.stderrFiber = Effect.runFork(this.collectStderrEffect());
    if (options.signal) {
      if (options.signal.aborted) {
        void this.close();
      } else {
        options.signal.addEventListener("abort", () => void this.close(), { once: true });
      }
    }
  }

  /** Return sanitized diagnostics captured from the subprocess. */
  get diagnostics(): readonly string[] {
    return [...this.stderrDiagnostics];
  }

  /** Read the next protocol line from the subprocess. */
  readLine(): Promise<string | null> {
    return Effect.runPromise(this.readLineEffect());
  }

  private readLineEffect(): Effect.Effect<string | null, CodexError> {
    if (this.closed && this.stdoutBuffer.byteLength === 0) {
      return Effect.succeed(null);
    }
    return Effect.gen({ self: this }, function* () {
      const reader = yield* Effect.try({
        try: () => this.stdoutReader.getReader(),
        catch: (error) =>
          new CodexError(
            "transport_failure",
            "The App Server stdout could not be read.",
            {},
            { cause: error },
          ),
      });
      const read = Effect.gen({ self: this }, function* () {
        while (true) {
          const newline = this.stdoutBuffer.indexOf(10);
          if (newline >= 0) {
            if (newline > this.maxLineBytes) {
              yield* Effect.ignore(
                Effect.tryPromise({ try: () => this.close(), catch: () => undefined }),
              );
              return yield* Effect.fail(
                new CodexError(
                  "invalid_transport_line",
                  "The App Server emitted an overlong line.",
                ),
              );
            }
            const bytes = this.stdoutBuffer.slice(0, newline);
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            const lineBytes = bytes.at(-1) === 13 ? bytes.slice(0, -1) : bytes;
            return yield* decodeTransportLine(lineBytes, this.lineDecoder);
          }
          if (this.stdoutBuffer.byteLength > this.maxLineBytes) {
            yield* Effect.ignore(
              Effect.tryPromise({ try: () => this.close(), catch: () => undefined }),
            );
            return yield* Effect.fail(
              new CodexError("invalid_transport_line", "The App Server emitted an overlong line."),
            );
          }
          const result = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (error) =>
              new CodexError(
                "transport_failure",
                "The App Server stdout could not be read.",
                {},
                { cause: error },
              ),
          });
          if (result.done) {
            if (this.stdoutBuffer.byteLength === 0) {
              return null;
            }
            if (this.stdoutBuffer.byteLength > this.maxLineBytes) {
              yield* Effect.ignore(
                Effect.tryPromise({ try: () => this.close(), catch: () => undefined }),
              );
              return yield* Effect.fail(
                new CodexError(
                  "invalid_transport_line",
                  "The App Server emitted an overlong line.",
                ),
              );
            }
            const bytes = this.stdoutBuffer;
            this.stdoutBuffer = new Uint8Array(0);
            return yield* decodeTransportLine(bytes, this.lineDecoder);
          }
          const next = new Uint8Array(this.stdoutBuffer.byteLength + result.value.byteLength);
          next.set(this.stdoutBuffer, 0);
          next.set(result.value, this.stdoutBuffer.byteLength);
          this.stdoutBuffer = next;
        }
      });
      return yield* Effect.ensuring(
        read,
        Effect.sync(() => reader.releaseLock()),
      );
    });
  }

  /** Write one protocol line to the subprocess. */
  writeLine(line: string): Promise<void> {
    return Effect.runPromise(this.writeLineEffect(line));
  }

  private writeLineEffect(line: string): Effect.Effect<void, CodexError> {
    if (this.closed) {
      return Effect.fail(new CodexError("closed", "The App Server transport is closed."));
    }
    if (new TextEncoder().encode(line).byteLength > this.maxLineBytes) {
      return Effect.fail(
        new CodexError("invalid_transport_line", "The App Server request exceeded the line limit."),
      );
    }
    return Effect.gen({ self: this }, function* () {
      yield* Effect.tryPromise({
        try: () => Promise.resolve(this.stdin.write(`${line}\n`)),
        catch: (error) =>
          new CodexError(
            "transport_failure",
            "The App Server stdin could not be written.",
            {},
            { cause: error },
          ),
      });
      yield* Effect.tryPromise({
        try: () => Promise.resolve(this.stdin.flush()),
        catch: (error) =>
          new CodexError(
            "transport_failure",
            "The App Server stdin could not be written.",
            {},
            { cause: error },
          ),
      });
    });
  }

  /** Close the subprocess and release its transport resources. */
  close(): Promise<void> {
    if (this.closeEffect === undefined) {
      if (this.closed) return Promise.resolve();
      this.closed = true;
      this.closeEffect = Effect.runSync(Effect.cached(this.closeTransportEffect()));
    }
    return Effect.runPromise(this.closeEffect);
  }

  private closeTransportEffect(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.ignore(
        Effect.tryPromise({
          try: () => Promise.resolve(this.stdin.end()),
          catch: () => undefined,
        }),
      );
      yield* Effect.ignore(Effect.try({ try: () => this.process.kill(), catch: () => undefined }));
      yield* Effect.race(
        Effect.ignore(
          Effect.tryPromise({ try: () => this.process.exited, catch: () => undefined }),
        ),
        Effect.sleep(1000),
      );
      yield* Effect.ignore(Fiber.await(this.stderrFiber));
    });
  }

  private collectStderrEffect(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const exit = yield* Effect.exit(
        readBoundedStreamEffect(this.stderrStream, this.maxDiagnosticBytes),
      );
      if (Exit.isFailure(exit)) {
        this.stderrDiagnostics.push("[stderr unavailable]");
        return;
      }
      const text = yield* Effect.try({
        try: () => decodeUtf8(exit.value, "Codex stderr"),
        catch: (error) =>
          error instanceof CodexError
            ? error
            : new CodexError(
                "transport_failure",
                "Codex stderr could not be decoded.",
                {},
                { cause: error },
              ),
      });
      for (const line of text.split(/\r?\n/u).slice(0, 128)) {
        const sanitized = sanitizeDiagnostic(line);
        if (sanitized.length > 0) {
          this.stderrDiagnostics.push(sanitized);
        }
      }
    }).pipe(Effect.orDie);
  }
}

function decodeTransportLine(
  bytes: Uint8Array,
  decoder: TextDecoder,
): Effect.Effect<string, CodexError> {
  return Effect.try({
    try: () => decoder.decode(bytes),
    catch: (error) =>
      new CodexError(
        "invalid_transport_line",
        "The App Server emitted invalid UTF-8.",
        {},
        { cause: error },
      ),
  });
}
