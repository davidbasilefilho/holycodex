// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessAlive, readLockPid, tryAcquireLock } from "./lock.ts";

describe("daemon lock", () => {
  it("acquires, rejects a live owner, and reaps a stale owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "holycodex-lock-"));
    const path = join(directory, "daemon.lock");
    const handle = tryAcquireLock(path);
    expect(handle).not.toBeNull();
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(readLockPid(path)).toBe(process.pid);
    expect(tryAcquireLock(path)).toBeNull();
    handle?.release();
    writeFileSync(path, "2000000000\n");
    expect(tryAcquireLock(path)).not.toBeNull();
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
  });
});
