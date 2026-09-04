// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";

import {
  bootstrapOfficialMarketplace,
  createOfficialPluginAdapter,
  parseOfficialMarketplaceSnapshot,
  resolveOfficialPluginEntry,
} from "./index.ts";

describe("official plugin identity resolution", () => {
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
