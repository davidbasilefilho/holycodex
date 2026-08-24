// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { tryAcquireLock, type LockHandle, unlinkQuietly } from "./lock.ts";
import type { DaemonPaths } from "./paths.ts";

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 500;
const CLI_ENV = "CODEX_LSP_DAEMON_CLI";

export class DaemonUnreachableError extends Error {
  constructor(readonly socketPath: string) {
    super(`LSP daemon did not become reachable at ${socketPath}`);
    this.name = "DaemonUnreachableError";
  }
}
export interface EnsureDaemonDeps {
  readonly probe: (socketPath: string) => Promise<boolean>;
  readonly acquireLock: (lockPath: string) => LockHandle | null;
  readonly cleanupStaleSocket: (socketPath: string) => void;
  readonly spawnDaemon: (paths: DaemonPaths) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}
export interface EnsureDaemonOptions {
  readonly readyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** Ensures one versioned daemon is reachable, coordinating concurrent starters with a lock. */
export async function ensureDaemonRunning(
  paths: DaemonPaths,
  deps: EnsureDaemonDeps = defaultEnsureDaemonDeps(),
  options: EnsureDaemonOptions = {},
): Promise<void> {
  const timeout = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (await deps.probe(paths.socket)) return;
  const lock = deps.acquireLock(paths.lock);
  if (lock === null) {
    await waitUntilReachable(paths.socket, deps, timeout, interval);
    return;
  }
  try {
    if (await deps.probe(paths.socket)) return;
    deps.cleanupStaleSocket(paths.socket);
    deps.spawnDaemon(paths);
    await waitUntilReachable(paths.socket, deps, timeout, interval);
  } finally {
    lock.release();
  }
}

async function waitUntilReachable(
  socketPath: string,
  deps: EnsureDaemonDeps,
  timeout: number,
  interval: number,
): Promise<void> {
  const deadline = deps.now() + timeout;
  while (true) {
    if (await deps.probe(socketPath)) return;
    if (deps.now() >= deadline) throw new DaemonUnreachableError(socketPath);
    await deps.sleep(interval);
  }
}

/** Probes POSIX sockets and Windows named pipes with a bounded connection attempt. */
export function probeSocket(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Spawns the daemon detached with a bounded log file and no inherited stdio. */
export function spawnDaemonProcess(paths: DaemonPaths): void {
  mkdirSync(dirname(paths.log), { recursive: true });
  const fd = openSync(paths.log, "a");
  try {
    const child = spawn(execPath, [resolveDaemonCliPath(), "daemon"], {
      cwd: tmpdir(),
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
}

/** Resolves the explicit daemon CLI override or this package's bundled CLI entry. */
export function resolveDaemonCliPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env[CLI_ENV]?.trim();
  if (override) return override;
  const current = fileURLToPath(import.meta.url);
  return basename(current) === "ensure-daemon.ts" ? join(dirname(current), "cli.ts") : current;
}

/** Creates the production effect ports used by ensureDaemonRunning. */
export function defaultEnsureDaemonDeps(): EnsureDaemonDeps {
  return {
    probe: probeSocket,
    acquireLock: (path) => tryAcquireLock(path),
    cleanupStaleSocket: (path) => {
      if (existsSync(path)) unlinkQuietly(path);
    },
    spawnDaemon: spawnDaemonProcess,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
