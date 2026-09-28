// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import {
  bootstrapOfficialMarketplace,
  createOfficialPluginAdapter,
  parseOfficialMarketplaceSnapshot,
  resolveOfficialPluginEntry,
} from "./index.ts";

describe("official plugin identity resolution", () => {
  const canonicalMarketplace = {
    name: "holycodex",
    root: "/codex/plugins/marketplaces/holycodex",
    marketplaceSource: {
      sourceType: "git",
      source: "davidbasilefilho/holycodex",
    },
  } as const;

  const marketplaceList = (marketplaces: readonly unknown[]) => ({
    exitCode: 0,
    stdout: JSON.stringify({ marketplaces }),
    stderr: "",
  });

  test("adds and verifies the canonical marketplace on first install", async () => {
    const commands: string[][] = [];
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          commands.push([...args]);
          if (args[2] === "list") {
            return marketplaceList(
              commands.filter((command) => command[2] === "add").length
                ? [canonicalMarketplace]
                : [],
            );
          }
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
    });
    await adapter.addMarketplace("davidbasilefilho/holycodex");
    expect(commands).toEqual([
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", "davidbasilefilho/holycodex"],
      ["plugin", "marketplace", "list", "--json"],
    ]);
  });

  test("refreshes an existing canonical marketplace on every install", async () => {
    const commands: string[][] = [];
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          commands.push([...args]);
          return args[2] === "list"
            ? marketplaceList([canonicalMarketplace])
            : { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
    });
    await adapter.addMarketplace("davidbasilefilho/holycodex");
    await adapter.addMarketplace("davidbasilefilho/holycodex");
    expect(commands.filter((command) => command[2] === "upgrade")).toEqual([
      ["plugin", "marketplace", "upgrade", "holycodex"],
      ["plugin", "marketplace", "upgrade", "holycodex"],
    ]);
    expect(commands.some((command) => command[2] === "add")).toBe(false);
  });

  test("rejects name and source conflicts before mutating Codex", async () => {
    const existing = [
      { ...canonicalMarketplace, marketplaceSource: { sourceType: "git", source: "someone/else" } },
    ];
    const commands: string[][] = [];
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          commands.push([...args]);
          return marketplaceList(existing);
        },
      },
    });
    await expect(adapter.addMarketplace("davidbasilefilho/holycodex")).rejects.toMatchObject({
      code: "marketplace_invalid",
      message: expect.stringContaining("holycodex"),
    });
    expect(commands).toEqual([["plugin", "marketplace", "list", "--json"]]);

    const alias = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async () => marketplaceList([{ ...canonicalMarketplace, name: "holycodex-copy" }]),
      },
    });
    await expect(alias.addMarketplace("davidbasilefilho/holycodex")).rejects.toMatchObject({
      code: "marketplace_invalid",
      message: expect.stringContaining("holycodex-copy"),
    });
  });

  test("fails actionably on command failure and mismatched readback", async () => {
    const failed = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) =>
          args[2] === "list"
            ? marketplaceList([])
            : { exitCode: 1, stdout: "", stderr: "network unavailable" },
      },
    });
    await expect(failed.addMarketplace("davidbasilefilho/holycodex")).rejects.toMatchObject({
      code: "command_failed",
      message: expect.stringContaining("marketplace add"),
    });

    const failedRefresh = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) =>
          args[2] === "list"
            ? marketplaceList([canonicalMarketplace])
            : { exitCode: 1, stdout: "", stderr: "refresh unavailable" },
      },
    });
    await expect(failedRefresh.addMarketplace("davidbasilefilho/holycodex")).rejects.toMatchObject({
      code: "command_failed",
      message: expect.stringContaining("marketplace upgrade"),
    });

    const mismatch = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          if (args[2] === "list") return marketplaceList([]);
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
    });
    await expect(mismatch.addMarketplace("davidbasilefilho/holycodex")).rejects.toMatchObject({
      code: "readback_mismatch",
    });
  });

  test("resolves an enabled Codex remote provider to its canonical identity", () => {
    const resolved = resolveOfficialPluginEntry(
      {
        installed: [
          {
            pluginId: "build-web-apps@openai-curated-remote",
            installed: true,
            enabled: true,
            marketplaceName: "openai-curated-remote",
          },
        ],
        available: [],
      },
      "build-web-apps@openai-curated",
    );
    expect(resolved?.identity.canonicalPluginId).toBe("build-web-apps@openai-curated");
    expect(resolved?.entry.pluginId).toBe("build-web-apps@openai-curated-remote");
  });

  test("resolves Codex remote Sites as the bundled Sites capability", () => {
    const resolved = resolveOfficialPluginEntry(
      {
        installed: [
          {
            pluginId: "sites@openai-curated-remote",
            installed: true,
            enabled: true,
            marketplaceName: "openai-curated-remote",
          },
        ],
        available: [],
      },
      "sites@openai-bundled",
    );
    expect(resolved?.identity.canonicalPluginId).toBe("sites@openai-bundled");
    expect(resolved?.entry.pluginId).toBe("sites@openai-curated-remote");
  });

  test("does not resolve same-name third-party entries", () => {
    const live = {
      installed: [
        {
          pluginId: "codex-security@crowdstrike",
          installed: true,
          enabled: true,
          marketplaceName: "crowdstrike",
        },
      ],
      available: [],
    };
    expect(resolveOfficialPluginEntry(live, "codex-security@openai-curated")).toBeUndefined();
  });

  test("does not bootstrap an unrelated curated provider", async () => {
    let initialized = false;
    await expect(
      bootstrapOfficialMarketplace({
        codexHome: "/tmp/codex-bootstrap-unrelated",
        executablePath: "/tmp/codex",
        selectedPluginIds: ["crowdstrike@openai-curated"],
        initializeRuntime: async () => {
          initialized = true;
          return async () => undefined;
        },
      }),
    ).resolves.toBeUndefined();
    expect(initialized).toBe(false);
  });

  test("validates only selected providers in an otherwise trusted marketplace", () => {
    const snapshot = parseOfficialMarketplaceSnapshot(
      {
        name: "openai-curated",
        source: "https://github.com/openai/plugins.git",
        plugins: [
          { name: "build-web-apps", source: "plugins/build-web-apps" },
          { name: "crowdstrike", source: "https://unavailable.example/provider" },
        ],
      },
      "plugins/openai-plugins",
      "plugins/openai-plugins/marketplace.json",
      ["build-web-apps"],
    );
    expect(snapshot.plugins).toEqual([
      { name: "build-web-apps", source: "plugins/build-web-apps" },
    ]);
    expect(() =>
      parseOfficialMarketplaceSnapshot(
        {
          name: "openai-curated",
          source: "https://github.com/openai/plugins.git",
          plugins: [{ name: "build-web-apps", source: "../escape" }],
        },
        "plugins/openai-plugins",
        "plugins/openai-plugins/marketplace.json",
        ["build-web-apps"],
      ),
    ).toThrow("unsafe");
  });

  test("accepts a remote provider during add readback", async () => {
    const commands: string[][] = [];
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          commands.push([...args]);
          if (args[1] === "add") return { exitCode: 0, stdout: "{}", stderr: "" };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              installed: [
                {
                  pluginId: "build-web-apps@openai-curated-remote",
                  installed: true,
                  enabled: true,
                  marketplaceName: "openai-curated-remote",
                },
              ],
              available: [],
            }),
            stderr: "",
          };
        },
      },
    });
    await adapter.add("build-web-apps@openai-curated");
    expect(commands).toEqual([
      ["plugin", "add", "build-web-apps@openai-curated", "--json"],
      ["plugin", "list", "--json"],
    ]);
  });
});
