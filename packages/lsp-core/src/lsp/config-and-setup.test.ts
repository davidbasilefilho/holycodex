// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../request-context.ts";
import { getMergedServers } from "./config-loader.ts";
import { BUILTIN_SERVERS } from "./server-definitions.ts";
import { findServerForExtension } from "./server-resolution.ts";
import { setupLspServer } from "./setup.ts";
import { resolveWorkspacePath } from "./workspace-security.ts";

describe("LSP configuration and safety boundaries", () => {
  it("uses project-before-user precedence and retains valid unknown fields", () => {
    const root = mkdtempSync(join(tmpdir(), "holycodex-lsp-config-"));
    const project = join(root, "project.json");
    const user = join(root, "user.json");
    writeFileSync(
      project,
      JSON.stringify({
        lsp: { custom: { command: ["missing"], extensions: [".custom"], extra: true } },
      }),
    );
    writeFileSync(
      user,
      JSON.stringify({ lsp: { custom: { command: ["other"], extensions: [".custom"] } } }),
    );
    const servers = runWithRequestContext(
      {
        cwd: root,
        env: { HOLYCODEX_LSP_PROJECT_CONFIG: project, HOLYCODEX_LSP_USER_CONFIG: user },
      },
      () => getMergedServers(),
    );
    expect(servers.find((server) => server.id === "custom")?.command).toEqual(["missing"]);
  });

  it("detects an unavailable server before any spawn and returns setup-required state", () => {
    const result = findServerForExtension(".ts", {
      installation: { environment: { PATH: "" }, exists: () => false, isFile: () => false },
    });
    expect(result.status).toBe("not_installed");
  });

  it("writes only the owned project configuration after validating an explicit executable", () => {
    const root = mkdtempSync(join(tmpdir(), "holycodex-lsp-setup-"));
    const result = setupLspServer({
      serverId: "typescript",
      root,
      executable: process.execPath,
      args: ["--version"],
    });
    expect(result.configPath).toBe(join(root, ".codex", "lsp-client.json"));
    expect(JSON.parse(readFileSync(result.configPath, "utf8")).lsp.typescript.command[0]).toBe(
      process.execPath,
    );
    expect(() =>
      setupLspServer({
        serverId: "typescript",
        root,
        executable: process.execPath,
        configPath: join(root, "outside.json"),
      }),
    ).toThrow("may write only");
  });

  it("rejects workspace traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "holycodex-lsp-root-"));
    expect(() => resolveWorkspacePath(root, join(root, "..", "outside.ts"))).toThrow(
      "escapes workspace",
    );
    expect(BUILTIN_SERVERS["typescript"]?.extensions).toContain(".ts");
  });
});
