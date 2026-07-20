import { describe, expect, it } from "vitest";

import {
  replaceCodexSlimEditMcpSpec,
  replaceCodexSlimEditVersion,
} from "../scripts/codexslimedit-version.mjs";
import { nextDevVersion, nextZeroVersion, versionedJson } from "../scripts/version.mjs";

describe("zerover versioning", () => {
  it("bumps fixes on the patch component", () => {
    expect(nextZeroVersion("0.2.0", "patch")).toBe("0.2.1");
  });

  it("bumps breaking changes on the second component", () => {
    expect(nextZeroVersion("0.2.7", "minor")).toBe("0.3.0");
  });

  it("accepts an explicit zerover version and rejects 1.x", () => {
    expect(nextZeroVersion("0.2.0", "0.4.3")).toBe("0.4.3");
    expect(() => nextZeroVersion("0.2.0", "1.0.0")).toThrow(/Usage/);
  });

  it("derives unique npm dev-channel prerelease versions", () => {
    expect(nextDevVersion("0.6.0", "42", "3")).toBe("0.6.0-dev.42.3");
    expect(nextDevVersion("0.6.0-rc.2", "42", "3")).toBe("0.6.0-dev.42.3");
    expect(() => nextDevVersion("0.6.0", "run", "1")).toThrow(/Usage/);
  });

  it("keeps the CLI and plugin package versions exact", () => {
    const source = {
      name: "holycodex",
      version: "0.6.0",
      dependencies: { "@holycodex/plugin": "0.6.0", retained: "1.0.0" },
    };
    expect(versionedJson("packages/cli/package.json", source, "0.6.0-dev.4.2")).toEqual({
      ...source,
      version: "0.6.0-dev.4.2",
      dependencies: { "@holycodex/plugin": "0.6.0-dev.4.2", retained: "1.0.0" },
    });
  });
});

describe("codexslimedit versioning", () => {
  const source =
    '/** Current package version. */\nexport const CODEX_SLIM_EDIT_VERSION = "0.1.0";\n';

  it("updates the bundled source version alongside manifest-only mutation", () => {
    const manifest = { name: "codexslimedit", version: "0.1.0" };
    const devManifest = { ...manifest, version: "0.7.4-dev.42.3" };

    expect(source).not.toContain(`CODEX_SLIM_EDIT_VERSION = "${devManifest.version}"`);
    expect(replaceCodexSlimEditVersion(source, devManifest.version)).toContain(
      `CODEX_SLIM_EDIT_VERSION = "${devManifest.version}"`,
    );
  });

  it("updates the bundled declaration version", () => {
    const declaration =
      '/** Current package version. */\nexport declare const CODEX_SLIM_EDIT_VERSION = "0.1.0";\n';
    expect(replaceCodexSlimEditVersion(declaration, "0.7.4-dev.42.3")).toContain(
      'CODEX_SLIM_EDIT_VERSION = "0.7.4-dev.42.3"',
    );
  });

  it("rejects malformed versions and source declarations", () => {
    expect(() => replaceCodexSlimEditVersion(source, "dev")).toThrow("Invalid version");
    expect(() => replaceCodexSlimEditVersion(source, "0.2.0-rc.1")).toThrow("Invalid version");
    expect(() =>
      replaceCodexSlimEditVersion('export const OTHER_VERSION = "0.1.0";\n', "0.2.0"),
    ).toThrow("exactly one CODEX_SLIM_EDIT_VERSION declaration");
    expect(() => replaceCodexSlimEditVersion(`${source}${source}`, "0.2.0")).toThrow(
      "exactly one CODEX_SLIM_EDIT_VERSION declaration",
    );
  });

  it("selects the CodexSlimEdit MCP channel and preserves other configuration", () => {
    const mcpSource = JSON.stringify({
      retained: true,
      mcpServers: {
        lsp: { command: "node", args: ["runtime/lsp.js", "mcp"] },
        codexslimedit: {
          command: "bunx",
          args: ["codexslimedit@latest"],
          retained: "value",
        },
      },
    });
    const devConfig = JSON.parse(replaceCodexSlimEditMcpSpec(mcpSource, "0.7.4-dev.42.3"));
    expect(devConfig).toEqual({
      retained: true,
      mcpServers: {
        lsp: { command: "node", args: ["runtime/lsp.js", "mcp"] },
        codexslimedit: {
          command: "bunx",
          args: ["codexslimedit@dev"],
          retained: "value",
        },
      },
    });
    expect(replaceCodexSlimEditMcpSpec(JSON.stringify(devConfig), "0.2.0")).toContain(
      '"codexslimedit@latest"',
    );
  });

  it("rejects malformed CodexSlimEdit MCP configuration", () => {
    expect(() => replaceCodexSlimEditMcpSpec("{}", "0.2.0")).toThrow("CodexSlimEdit MCP server");
    expect(() =>
      replaceCodexSlimEditMcpSpec(
        JSON.stringify({
          mcpServers: { codexslimedit: { command: "bunx", args: ["codexslimedit"] } },
        }),
        "0.2.0",
      ),
    ).toThrow("CodexSlimEdit MCP server");
  });
});
