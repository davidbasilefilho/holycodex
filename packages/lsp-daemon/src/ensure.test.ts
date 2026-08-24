// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ensureDaemonRunning,
  type EnsureDaemonDeps,
  DaemonUnreachableError,
} from "./ensure-daemon.ts";
import type { LockHandle } from "./lock.ts";
import type { DaemonPaths } from "./paths.ts";

const paths: DaemonPaths = {
  version: "test",
  dir: "/tmp/holycodex-ensure/vtest",
  socket: "/tmp/holycodex-ensure/vtest/daemon.sock",
  lock: "/tmp/holycodex-ensure/vtest/daemon.lock",
  pid: "/tmp/holycodex-ensure/vtest/daemon.pid",
  log: "/tmp/holycodex-ensure/vtest/daemon.log",
};

function harness(probes: readonly boolean[], lock: boolean, afterSpawn: readonly boolean[] = []) {
  const queue = [...probes];
  const counts = { spawn: 0, cleanup: 0, acquire: 0, release: 0 };
  let now = 0;
  const handle: LockHandle = {
    release: () => {
      counts.release += 1;
    },
  };
  const deps: EnsureDaemonDeps = {
    probe: async () => queue.shift() ?? false,
    acquireLock: () => {
      if (!lock) return null;
      counts.acquire += 1;
      return handle;
    },
    cleanupStaleSocket: () => {
      counts.cleanup += 1;
    },
    spawnDaemon: () => {
      counts.spawn += 1;
      queue.push(...afterSpawn);
    },
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    now: () => now,
  };
  return { deps, counts };
}

describe("daemon ensure coordination", () => {
  it("waits behind a concurrent owner without spawning", async () => {
    const { deps, counts } = harness([false, false, true], false);
    await ensureDaemonRunning(paths, deps);
    expect(counts.spawn).toBe(0);
    expect(counts.acquire).toBe(0);
  });

  it("cleans stale state, starts once, and releases the lock", async () => {
    const { deps, counts } = harness([false, false], true, [true]);
    await ensureDaemonRunning(paths, deps);
    expect(counts.cleanup).toBe(1);
    expect(counts.spawn).toBe(1);
    expect(counts.release).toBe(1);
  });

  it("fails with bounded evidence when startup never becomes reachable", async () => {
    const { deps } = harness([false, false], true);
    await expect(
      ensureDaemonRunning(paths, deps, { readyTimeoutMs: 100, pollIntervalMs: 50 }),
    ).rejects.toBeInstanceOf(DaemonUnreachableError);
  });
});
