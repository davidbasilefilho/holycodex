// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import {
  CodexError,
  DEFAULT_MAX_DIAGNOSTIC_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  sanitizeText,
} from "./common";

export interface AsyncLineTransport {
  readLine(): Promise<string | null>;
  writeLine(line: string): Promise<void>;
  close(): Promise<void>;
}

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

export function createAllowlistedEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  return Object.freeze(allowlistedEnvironment(source));
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new CodexError("invalid_transport_line", "A subprocess stream exceeded its limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new CodexError(
      "invalid_transport_line",
      `Invalid UTF-8 in ${label}.`,
      {},
      { cause: error },
    );
  }
}

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

export function sanitizeDiagnostics(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => sanitizeDiagnostic(line))
    .filter((line) => line.length > 0)
    .slice(0, 128);
}

export interface BunStdioTransportOptions {
  readonly executablePath: string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly maxLineBytes?: number;
  readonly maxDiagnosticBytes?: number;
  readonly signal?: AbortSignal;
}

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
  private stderrPromise: Promise<void>;
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
    this.stderrPromise = this.collectStderr();
    if (options.signal) {
      if (options.signal.aborted) {
        void this.close();
      } else {
        options.signal.addEventListener("abort", () => void this.close(), { once: true });
      }
    }
  }

  get diagnostics(): readonly string[] {
    return [...this.stderrDiagnostics];
  }

  async readLine(): Promise<string | null> {
    if (this.closed && this.stdoutBuffer.byteLength === 0) {
      return null;
    }
    const reader = this.stdoutReader.getReader();
    try {
      while (true) {
        const newline = this.stdoutBuffer.indexOf(10);
        if (newline >= 0) {
          if (newline > this.maxLineBytes) {
            await this.close();
            throw new CodexError(
              "invalid_transport_line",
              "The App Server emitted an overlong line.",
            );
          }
          const bytes = this.stdoutBuffer.slice(0, newline);
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          const lineBytes = bytes.at(-1) === 13 ? bytes.slice(0, -1) : bytes;
          return this.lineDecoder.decode(lineBytes);
        }
        if (this.stdoutBuffer.byteLength > this.maxLineBytes) {
          await this.close();
          throw new CodexError(
            "invalid_transport_line",
            "The App Server emitted an overlong line.",
          );
        }
        const result = await reader.read();
        if (result.done) {
          if (this.stdoutBuffer.byteLength === 0) {
            return null;
          }
          if (this.stdoutBuffer.byteLength > this.maxLineBytes) {
            await this.close();
            throw new CodexError(
              "invalid_transport_line",
              "The App Server emitted an overlong line.",
            );
          }
          const bytes = this.stdoutBuffer;
          this.stdoutBuffer = new Uint8Array(0);
          return this.lineDecoder.decode(bytes);
        }
        const next = new Uint8Array(this.stdoutBuffer.byteLength + result.value.byteLength);
        next.set(this.stdoutBuffer, 0);
        next.set(result.value, this.stdoutBuffer.byteLength);
        this.stdoutBuffer = next;
      }
    } catch (error: unknown) {
      if (error instanceof CodexError) {
        throw error;
      }
      throw new CodexError(
        "transport_failure",
        "The App Server stdout could not be read.",
        {},
        {
          cause: error,
        },
      );
    } finally {
      reader.releaseLock();
    }
  }

  async writeLine(line: string): Promise<void> {
    if (this.closed) {
      throw new CodexError("closed", "The App Server transport is closed.");
    }
    if (new TextEncoder().encode(line).byteLength > this.maxLineBytes) {
      throw new CodexError(
        "invalid_transport_line",
        "The App Server request exceeded the line limit.",
      );
    }
    try {
      await this.stdin.write(`${line}\n`);
      await this.stdin.flush();
    } catch (error: unknown) {
      throw new CodexError(
        "transport_failure",
        "The App Server stdin could not be written.",
        {},
        {
          cause: error,
        },
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await Promise.resolve(this.stdin.end());
    } catch {
      // The subprocess may already have closed its stdin.
    }
    try {
      this.process.kill();
    } catch {
      // Termination is best effort after the close boundary is set.
    }
    await Promise.race([
      this.process.exited,
      new Promise<number>((resolveExit) => setTimeout(() => resolveExit(-1), 1000)),
    ]);
    await this.stderrPromise.catch(() => undefined);
  }

  private async collectStderr(): Promise<void> {
    try {
      const bytes = await readBoundedStream(this.stderrStream, this.maxDiagnosticBytes);
      const text = decodeUtf8(bytes, "Codex stderr");
      for (const line of text.split(/\r?\n/u).slice(0, 128)) {
        const sanitized = sanitizeDiagnostic(line);
        if (sanitized.length > 0) {
          this.stderrDiagnostics.push(sanitized);
        }
      }
    } catch {
      this.stderrDiagnostics.push("[stderr unavailable]");
    }
  }
}
