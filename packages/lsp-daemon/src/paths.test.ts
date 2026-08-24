// SPDX-License-Identifier: Apache-2.0

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  daemonBaseDir,
  daemonPaths,
  resolveDaemonVersion,
  resolveDaemonVersionFromEnv,
} from "./paths.ts";

describe("daemon paths", () => {
  it("honors directory precedence and versioned state", () => {
    expect(daemonBaseDir({ CODEX_LSP_DAEMON_DIR: "/custom" })).toBe("/custom");
    expect(daemonBaseDir({ PLUGIN_DATA: "/data" })).toBe(join("/data", "daemon"));
    expect(daemonBaseDir({ CODEX_HOME: "/home/.codex" })).toBe(
      join("/home/.codex", "codex-lsp", "daemon"),
    );
    expect(daemonBaseDir({})).toBe(join(homedir(), ".codex", "codex-lsp", "daemon"));
    const paths = daemonPaths({ CODEX_LSP_DAEMON_DIR: "/d" }, "1.2.3");
    expect(paths.dir).toBe(join(resolve("/d"), "v1.2.3"));
    expect(paths.lock).toBe(join(resolve("/d"), "v1.2.3", "daemon.lock"));
  });

  it("uses a short POSIX endpoint for long roots and rejects unsafe versions", () => {
    const paths = daemonPaths({ CODEX_LSP_DAEMON_DIR: `/${"x".repeat(120)}` }, "1.0.0");
    if (process.platform === "win32") expect(paths.socket).toContain("\\\\.\\pipe\\");
    else {
      expect(paths.socket.startsWith(tmpdir())).toBe(true);
      expect(paths.socket.length).toBeLessThan(100);
    }
    expect(resolveDaemonVersionFromEnv({ CODEX_LSP_DAEMON_VERSION: " ../../bad " })).toBeNull();
  });

  it("supports injected package-version resolution", () => {
    expect(
      resolveDaemonVersion((id) => (id === "./package.json" ? { version: "9.9.9" } : {})),
    ).toBe("9.9.9");
  });
});
