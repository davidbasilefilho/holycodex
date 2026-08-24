// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { disposeDefaultLspManager, getLspManager } from "@holycodex/lsp-core";
import { daemonNoncePath, type DaemonPaths } from "./paths.ts";
import { unlinkQuietly } from "./lock.ts";
import { handleDaemonMessage } from "./request-routing.ts";
import { createLineDecoder, encodeJsonLine } from "./socket-json.ts";

const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60_000;
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 60_000;
export interface DaemonServerOptions {
  readonly idleShutdownMs?: number;
  readonly idleCheckIntervalMs?: number;
  readonly onIdleShutdown?: () => void;
  readonly nonce?: string;
}
export interface DaemonServerHandle {
  readonly server: Server;
  readonly close: () => Promise<void>;
  readonly nonce: string;
}

function safeStatePath(paths: DaemonPaths, path: string): boolean {
  return (
    path === join(paths.dir, "daemon.sock") ||
    (path.startsWith(join(tmpdir(), "holycodex-lsp-")) &&
      basename(path).startsWith("holycodex-lsp-") &&
      !basename(path).includes("..")) ||
    path === join(paths.dir, "daemon.pid") ||
    path === join(paths.dir, "daemon.endpoint") ||
    path === daemonNoncePath(paths) ||
    path === paths.lock ||
    path === paths.log
  );
}
function removeSocket(paths: DaemonPaths): void {
  if (process.platform !== "win32" && safeStatePath(paths, paths.socket))
    unlinkQuietly(paths.socket);
}
function writeOwned(path: string, value: string): void {
  if (existsSync(path)) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing symlink state path: ${path}`);
    } catch {
      throw new Error(`unable to validate daemon state path: ${path}`);
    }
  }
  writeFileSync(path, value, "utf8");
}

/** Starts a nonce-authenticated local daemon on POSIX sockets or Windows named pipes. */
export async function startDaemonServer(
  paths: DaemonPaths,
  options: DaemonServerOptions = {},
): Promise<DaemonServerHandle> {
  mkdirSync(dirname(paths.pid), { recursive: true });
  removeSocket(paths);
  const nonce = options.nonce ?? randomBytes(32).toString("hex");
  writeOwned(daemonNoncePath(paths), `${nonce}\n`);
  const connections = new Set<Socket>();
  let lastActiveAt = Date.now();
  const server = createServer((socket) => {
    connections.add(socket);
    lastActiveAt = Date.now();
    const decoder = createLineDecoder(
      (message) => {
        lastActiveAt = Date.now();
        void respond(socket, message, nonce);
      },
      (raw) => {
        if (socket.writable)
          socket.write(
            encodeJsonLine({
              id: null,
              error: {
                code: "invalid_request",
                message: `Malformed daemon JSON: ${raw.slice(0, 200)}`,
              },
            }),
          );
      },
    );
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      connections.delete(socket);
      lastActiveAt = Date.now();
    });
  });
  await listen(server, paths.socket);
  writeOwned(paths.pid, `${process.pid}\n`);
  writeOwned(join(paths.dir, "daemon.endpoint"), `${paths.socket}\n`);
  let closed = false;
  let signalHandler: (() => void) | undefined;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer);
    for (const socket of connections) socket.destroy();
    connections.clear();
    await closeServer(server);
    removeSocket(paths);
    unlinkQuietly(paths.pid);
    unlinkQuietly(join(paths.dir, "daemon.endpoint"));
    unlinkQuietly(daemonNoncePath(paths));
    if (signalHandler !== undefined) {
      process.removeListener("SIGTERM", signalHandler);
      process.removeListener("SIGINT", signalHandler);
    }
    await disposeDefaultLspManager();
  };
  const idleShutdownMs =
    options.idleShutdownMs ??
    environmentMilliseconds("HOLYCODEX_LSP_IDLE_SHUTDOWN_MS") ??
    DEFAULT_IDLE_SHUTDOWN_MS;
  const idleCheckIntervalMs =
    options.idleCheckIntervalMs ??
    environmentMilliseconds("HOLYCODEX_LSP_IDLE_CHECK_INTERVAL_MS") ??
    DEFAULT_IDLE_CHECK_INTERVAL_MS;
  const idleTimer = setInterval(() => {
    if (connections.size > 0 || getLspManager().clientCount() > 0) {
      lastActiveAt = Date.now();
      return;
    }
    if (Date.now() - lastActiveAt < idleShutdownMs) return;
    if (options.onIdleShutdown !== undefined) options.onIdleShutdown();
    else void close().then(() => process.exit(0));
  }, idleCheckIntervalMs);
  idleTimer.unref?.();
  signalHandler = (): void => {
    void close().then(() => process.exit(0));
  };
  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);
  return { server, close, nonce };
}

async function respond(socket: Socket, message: unknown, nonce: string): Promise<void> {
  try {
    const response = await handleDaemonMessage(message, { nonce });
    if (response !== undefined && socket.writable) socket.write(encodeJsonLine(response));
  } catch (error: unknown) {
    if (socket.writable)
      socket.write(
        encodeJsonLine({
          id: null,
          error: {
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
  }
}
function environmentMilliseconds(name: string): number | undefined {
  const value = process.env[name];
  return value !== undefined && /^\d+$/u.test(value) ? Number(value) : undefined;
}
function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
