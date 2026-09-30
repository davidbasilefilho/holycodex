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

  test("repairs a registered marketplace with an incomplete cached snapshot", async () => {
    const commands: string[][] = [];
    const events: string[] = [];
    let registered = false;
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      onMarketplaceConflict: () => events.push("warning"),
      runner: {
        run: async (args) => {
          commands.push([...args]);
          if (args[2] === "list" && !registered) {
            return {
              exitCode: 1,
              stdout: "",
              stderr:
                "Error: failed to load marketplace(s): - `holycodex` at C:/codex/.tmp/marketplaces/holycodex: marketplace root does not contain a supported manifest",
            };
          }
          if (args[2] === "list") return marketplaceList([canonicalMarketplace]);
          if (args[2] === "add") {
            events.push("add");
            registered = true;
          }
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
    });

    await adapter.addMarketplace("davidbasilefilho/holycodex");
    expect(events).toEqual(["warning", "add"]);
    expect(commands).toEqual([
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", "davidbasilefilho/holycodex"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
    ]);
  });

  test("does not repair another marketplace just because its path contains HolyCodex", async () => {
    const commands: string[][] = [];
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          commands.push([...args]);
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "Error: failed to load marketplace(s): - `openai-curated` at C:/codex/holycodex/.tmp/marketplaces/openai-curated: marketplace root does not contain a supported manifest",
          };
        },
      },
    });

    await expect(adapter.addMarketplace("davidbasilefilho/holycodex")).rejects.toMatchObject({
      code: "command_failed",
      message: expect.stringContaining("marketplace list failed"),
    });
    expect(commands).toEqual([["plugin", "marketplace", "list", "--json"]]);
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

  test("reconciles canonical HTTPS and SSH marketplace source forms", async () => {
    const canonicalSources = [
      "https://github.com/davidbasilefilho/holycodex.git",
      "https://github.com/davidbasilefilho/holycodex",
      "https://github.com/davidbasilefilho/holycodex.git/",
      "https://github.com/davidbasilefilho/holycodex/",
      "git@github.com:davidbasilefilho/holycodex.git",
      "git@github.com:davidbasilefilho/holycodex",
      "ssh://git@github.com/davidbasilefilho/holycodex.git",
      "ssh://git@github.com/davidbasilefilho/holycodex",
    ];

    for (const source of canonicalSources) {
      const commands: string[][] = [];
      const adapter = createOfficialPluginAdapter({
        executable: "codex",
        runner: {
          run: async (args) => {
            commands.push([...args]);
            return args[2] === "list"
              ? marketplaceList([
                  {
                    ...canonicalMarketplace,
                    marketplaceSource: { sourceType: "git", source },
                  },
                ])
              : { exitCode: 0, stdout: "{}", stderr: "" };
          },
        },
      });

      await adapter.addMarketplace("davidbasilefilho/holycodex");
      expect(commands).toEqual([
        ["plugin", "marketplace", "list", "--json"],
        ["plugin", "marketplace", "upgrade", "holycodex"],
        ["plugin", "marketplace", "list", "--json"],
      ]);
    }
  });

  test("warns and reconciles reserved-name and canonical-source conflicts", async () => {
    const cases = [
      {
        marketplaces: [
          {
            ...canonicalMarketplace,
            marketplaceSource: { sourceType: "git", source: "someone/else" },
          },
        ],
        removed: "holycodex",
      },
      {
        marketplaces: [{ ...canonicalMarketplace, name: "holycodex-copy" }],
        removed: "holycodex-copy",
      },
      {
        marketplaces: [
          canonicalMarketplace,
          {
            ...canonicalMarketplace,
            marketplaceSource: { sourceType: "git", source: "someone/else" },
          },
        ],
        removed: "holycodex",
      },
    ] as const;

    for (const scenario of cases) {
      const commands: string[][] = [];
      const warnings: string[] = [];
      const events: string[] = [];
      let marketplaces: readonly unknown[] = scenario.marketplaces;
      const adapter = createOfficialPluginAdapter({
        executable: "codex",
        onMarketplaceConflict: (message) => {
          warnings.push(message);
          events.push("warning");
        },
        runner: {
          run: async (args) => {
            commands.push([...args]);
            if (args[2] === "list") return marketplaceList(marketplaces);
            if (args[2] === "remove") {
              events.push(`remove:${args[3]}`);
              marketplaces = marketplaces.filter(
                (entry) => (entry as { name?: string }).name !== args[3],
              );
              return { exitCode: 0, stdout: "{}", stderr: "" };
            }
            if (args[2] === "add") {
              marketplaces = [canonicalMarketplace];
              return { exitCode: 0, stdout: "{}", stderr: "" };
            }
            throw new Error(`unexpected marketplace command: ${args.join(" ")}`);
          },
        },
      });

      await adapter.addMarketplace("davidbasilefilho/holycodex");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(scenario.removed);
      expect(events.indexOf("warning")).toBeLessThan(events.indexOf(`remove:${scenario.removed}`));
      expect(commands).toEqual([
        ["plugin", "marketplace", "list", "--json"],
        ["plugin", "marketplace", "remove", scenario.removed],
        ["plugin", "marketplace", "list", "--json"],
        ["plugin", "marketplace", "add", "davidbasilefilho/holycodex"],
        ["plugin", "marketplace", "list", "--json"],
      ]);
    }
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

  test("installs the migrated Computer Use provider and verifies its trusted identity", async () => {
    const commands: string[][] = [];
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          commands.push([...args]);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              installed: [
                {
                  pluginId: "unified-computer-use@openai-bundled",
                  installed: true,
                  enabled: true,
                  marketplaceName: "openai-bundled",
                },
              ],
              available: [],
            }),
            stderr: "",
          };
        },
      },
    });
    await adapter.add("computer-use@openai-bundled");
    expect(commands).toEqual([
      ["plugin", "add", "unified-computer-use@openai-bundled", "--json"],
      ["plugin", "list", "--json"],
    ]);
  });

  test("uses the supported remote catalog selector when the reserved CLI catalog has no entry", async () => {
    const commands: string[][] = [];
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          commands.push([...args]);
          if (args[1] === "add" && args[2] === "build-web-apps@openai-curated") {
            return {
              exitCode: 2,
              stdout: "",
              stderr:
                "Error: plugin `build-web-apps` was not found in marketplace `openai-curated`",
            };
          }
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
      ["plugin", "add", "build-web-apps@openai-curated-remote", "--json"],
      ["plugin", "list", "--json"],
    ]);
  });

  test("does not try another official selector after a non-catalog install failure", async () => {
    const commands: string[][] = [];
    const adapter = createOfficialPluginAdapter({
      executable: "codex",
      runner: {
        run: async (args) => {
          commands.push([...args]);
          return { exitCode: 1, stdout: "", stderr: "network unavailable" };
        },
      },
    });

    await expect(adapter.add("build-web-apps@openai-curated")).rejects.toMatchObject({
      code: "command_failed",
      message: expect.stringContaining("network unavailable"),
    });
    expect(commands).toEqual([["plugin", "add", "build-web-apps@openai-curated", "--json"]]);
  });
});
