import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runWithRequestContext } from "../request-context.js";
import { getMergedServers } from "./config-loader.js";
import {
  DocumentSymbolsResultSchema,
  ReferencesResultSchema,
  WorkspaceSymbolsResultSchema,
} from "./protocol-schemas.js";
import { loadInstallDecisions } from "./server-install-state.js";

describe("LSP persisted boundary validation", () => {
  it("accepts valid servers and skips entries with invalid nested fields", () => {
    const root = mkdtempSync(join(tmpdir(), "holycodex-lsp-config-"));
    const projectConfig = join(root, "lsp-client.json");
    const missingProjectConfig = join(root, "missing-project.json");
    writeFileSync(
      projectConfig,
      JSON.stringify({
        lsp: {
          valid: { command: ["valid-lsp"], extensions: [".valid"], priority: 1 },
          invalid: { command: ["bad-lsp"], extensions: [".bad"], priority: "first" },
        },
      }),
    );

    const servers = runWithRequestContext(
      {
        cwd: root,
        env: {
          LSP_TOOLS_MCP_PROJECT_CONFIG: missingProjectConfig,
          LSP_TOOLS_MCP_USER_CONFIG: projectConfig,
        },
      },
      getMergedServers,
    );

    expect(servers.some((server) => server.id === "valid")).toBe(true);
    expect(servers.some((server) => server.id === "invalid")).toBe(false);
  });

  it("preserves valid servers with extension fields", () => {
    const root = mkdtempSync(join(tmpdir(), "holycodex-lsp-config-"));
    const projectConfig = join(root, "lsp-client.json");
    const missingProjectConfig = join(root, "missing-project.json");
    writeFileSync(
      projectConfig,
      JSON.stringify({
        lsp: {
          extended: {
            command: ["extended-lsp"],
            extensions: [".extended"],
            args: ["--stdio"],
            rootMarkers: ["extended.json"],
          },
        },
      }),
    );

    const servers = runWithRequestContext(
      {
        cwd: root,
        env: {
          LSP_TOOLS_MCP_PROJECT_CONFIG: missingProjectConfig,
          LSP_TOOLS_MCP_USER_CONFIG: projectConfig,
        },
      },
      getMergedServers,
    );

    expect(servers.some((server) => server.id === "extended")).toBe(true);
  });

  it("normalizes a null references response to no references", () => {
    expect(ReferencesResultSchema.parse(null)).toEqual([]);
  });

  it("normalizes null document and workspace symbol responses to no symbols", () => {
    expect(DocumentSymbolsResultSchema.parse(null)).toEqual([]);
    expect(WorkspaceSymbolsResultSchema.parse(null)).toEqual([]);
  });

  it("falls back without consuming malformed install decisions", () => {
    const root = mkdtempSync(join(tmpdir(), "holycodex-lsp-decisions-"));
    const path = join(root, "decisions.json");
    writeFileSync(path, JSON.stringify({ rust: { decision: "maybe", decidedAt: 42 } }));

    const decisions = runWithRequestContext(
      { env: { LSP_TOOLS_MCP_INSTALL_DECISIONS: path } },
      loadInstallDecisions,
    );

    expect(decisions).toEqual({});
  });
});
