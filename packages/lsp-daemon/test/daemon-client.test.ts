import { describe, expect, it } from "vitest";

import { currentRequestContext } from "../src/daemon-client.js";

describe("currentRequestContext", () => {
  it("#given project, user, and install-decision config env #when building request context #then forwards only those keys", () => {
    const context = currentRequestContext({
      HOLYCODEX_LSP_PROJECT_CONFIG: ".codex/lsp-client.json:.codex/lsp.json",
      HOLYCODEX_LSP_USER_CONFIG: "~/.codex/lsp.json",
      HOLYCODEX_LSP_INSTALL_DECISIONS: "~/.codex/lsp-install-decisions.json",
      PATH: "/usr/bin",
      HOME: "/home/me",
    });

    expect(context.cwd).toBe(process.cwd());
    expect(context.env).toEqual({
      HOLYCODEX_LSP_PROJECT_CONFIG: ".codex/lsp-client.json:.codex/lsp.json",
      HOLYCODEX_LSP_USER_CONFIG: "~/.codex/lsp.json",
      HOLYCODEX_LSP_INSTALL_DECISIONS: "~/.codex/lsp-install-decisions.json",
    });
  });

  it("#given no lsp config env #when building request context #then forwards an empty env bag", () => {
    const context = currentRequestContext({ PATH: "/usr/bin" });

    expect(context.env).toEqual({});
  });
});
