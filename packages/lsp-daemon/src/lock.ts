// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  lstatSync,
} from "node:fs";
import { dirname } from "node:path";

export interface LockHandle {
  readonly release: () => void;
}
export interface LockOptions {
  readonly processAlive?: (pid: number) => boolean;
}

/** Checks a PID without treating permission denial as a stale process. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Reads and validates the first-line owner PID. */
export function readLockPid(lockPath: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(lockPath, "utf8").split("\n", 1)[0] ?? "", 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Acquires an exclusive lock, reaping only a validated stale regular lock. */
export function tryAcquireLock(
  lockPath: string,
  ownerPid = process.pid,
  options: LockOptions = {},
): LockHandle | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  const alive = options.processAlive ?? isProcessAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${ownerPid}\n`);
      closeSync(fd);
      return { release: () => unlinkQuietly(lockPath) };
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      let symbolic = false;
      try {
        symbolic = lstatSync(lockPath).isSymbolicLink();
      } catch {
        /* missing lock can be retried */
      }
      if (symbolic) return null;
      const pid = readLockPid(lockPath);
      if (pid !== null && alive(pid)) return null;
      unlinkQuietly(lockPath);
    }
  }
  return null;
}

/** Removes one exact state path while ignoring already-cleaned state. */
export function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* stale cleanup is idempotent */
  }
}
