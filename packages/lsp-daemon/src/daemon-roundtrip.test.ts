// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callToolViaDaemon } from "./daemon-client.ts";
import { startDaemonServer, type DaemonServerHandle } from "./daemon-server.ts";
import { daemonPaths, type DaemonPaths } from "./paths.ts";

const servers: DaemonServerHandle[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function paths(): DaemonPaths {
  const directory = mkdtempSync(join(tmpdir(), "holycodex-daemon-"));
  directories.push(directory);
  return daemonPaths({ CODEX_LSP_DAEMON_DIR: directory }, "test");
}

describe("daemon round trip", () => {
  it("validates the local socket protocol and returns the status tool", async () => {
    const daemonPathsValue = paths();
    const daemon = await startDaemonServer(daemonPathsValue, { onIdleShutdown: () => undefined });
    servers.push(daemon);
    const result = await callToolViaDaemon(
      "status",
      {},
      {
        paths: daemonPathsValue,
        ensure: async () => undefined,
      },
    );
    expect(result.content[0]?.text).toContain("Configured LSP servers");
  });
});
