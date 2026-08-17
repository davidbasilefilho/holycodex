// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { mkdir, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureOwnedDirectory, isFsCode, type ResolvedInstallerPaths } from "./paths.ts";
import { optionalJsonFile, writeAtomicJson } from "./storage.ts";

const LockMetadataSchema = type({
  "+": "reject",
  owner_pid: "number.integer > 0",
  run_id: type(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  started_at: type("string").narrow((value): value is string => !Number.isNaN(Date.parse(value))),
  expires_at: "number > 0",
});
type LockMetadata = typeof LockMetadataSchema.infer;

export interface LockOptions {
  readonly ttlMs: number;
  readonly pid: number;
  readonly runId: string;
  readonly now: () => Date;
}

export interface LockLease {
  readonly recovered: boolean;
  readonly metadata: LockMetadata;
  readonly release: () => Promise<void>;
}

export async function acquireInstallLock(
  paths: ResolvedInstallerPaths,
  options: LockOptions,
  appendRecovery: (metadata: Readonly<Record<string, string | number>>) => Promise<void>,
): Promise<LockLease> {
  await ensureOwnedDirectory(paths.codexHome);
  const lockDirectory = paths.lock;
  let recovered = false;
  try {
    await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
  } catch (error: unknown) {
    if (!isFsCode(error, "EEXIST")) {
      throw error;
    }
    const existingEntry = await lstat(lockDirectory);
    if (!existingEntry.isDirectory() || existingEntry.isSymbolicLink()) {
      throw new LockError("lock_invalid", "The installer lock is not a safe directory.");
    }
    let metadata: LockMetadata | undefined;
    try {
      metadata = await optionalJsonFile(join(lockDirectory, "owner.json"), LockMetadataSchema);
    } catch {
      throw new LockError("lock_invalid", "The installer lock metadata is missing or invalid.");
    }
    if (!metadata) {
      throw new LockError("lock_invalid", "The installer lock metadata is missing or invalid.");
    }
    const now = options.now().getTime();
    const expired = now > metadata.expires_at;
    const live = isProcessLive(metadata.owner_pid);
    if (!expired || live) {
      throw new LockError("lock_live", "Another HolyCodex operation owns CODEX_HOME.");
    }
    await appendRecovery({
      phase: "lock-recovery",
      previous_pid: metadata.owner_pid,
      previous_run_id: metadata.run_id,
    });
    await rm(lockDirectory, { recursive: true, force: false });
    recovered = true;
    await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
  }
  const now = options.now();
  const metadata: LockMetadata = {
    owner_pid: options.pid,
    run_id: options.runId,
    started_at: now.toISOString(),
    expires_at: now.getTime() + options.ttlMs,
  };
  await writeAtomicJson(join(lockDirectory, "owner.json"), metadata);
  let released = false;
  return {
    recovered,
    metadata,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      const entry = await lstat(lockDirectory).catch((error: unknown) => {
        if (isFsCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (!entry) {
        return;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new LockError("lock_invalid", "The installer lock changed while held.");
      }
      const current = await optionalJsonFile(join(lockDirectory, "owner.json"), LockMetadataSchema);
      if (
        !current ||
        current.owner_pid !== metadata.owner_pid ||
        current.run_id !== metadata.run_id
      ) {
        throw new LockError("lock_invalid", "The installer lock owner changed while held.");
      }
      await rm(lockDirectory, { recursive: true, force: false });
    },
  };
}

function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export class LockError extends Error {
  readonly code: "lock_live" | "lock_invalid";

  constructor(code: "lock_live" | "lock_invalid", message: string) {
    super(message);
    this.name = "LockError";
    this.code = code;
  }
}
