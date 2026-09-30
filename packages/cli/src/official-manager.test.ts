// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReadOnlyCodexPluginStatus } from "./official-manager.ts";

describe("read-only official plugin status", () => {
  let temporaryHome: string | undefined;

  afterEach(async () => {
    if (temporaryHome !== undefined) await rm(temporaryHome, { recursive: true, force: true });
    temporaryHome = undefined;
  });

  test("uses an enabled, cached official alias when another accepted alias is disabled", async () => {
    temporaryHome = await mkdtemp(join(tmpdir(), "holycodex-plugin-alias-status-"));
    await writeFile(
      join(temporaryHome, "config.toml"),
      '[plugins."sites@openai-bundled"]\nenabled = false\n[plugins."sites@openai-curated-remote"]\nenabled = true\n',
    );
    const cacheDirectory = join(
      temporaryHome,
      "plugins",
      "cache",
      "openai-curated-remote",
      "sites",
      "fixture-cache",
      ".codex-plugin",
    );
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, "plugin.json"), "{}\n");

    const manager = new ReadOnlyCodexPluginStatus(temporaryHome);
    expect(await manager.status(["sites@openai-bundled"])).toEqual({
      "sites@openai-bundled": "installed",
    });
    expect(manager.getObservedIdentities()).toEqual({
      "sites@openai-bundled": "sites@openai-curated-remote",
    });
  });

  test("matches a canonical configured provider to its remote cache identity", async () => {
    temporaryHome = await mkdtemp(join(tmpdir(), "holycodex-plugin-remote-cache-status-"));
    await writeFile(
      join(temporaryHome, "config.toml"),
      '[plugins."build-web-apps@openai-curated"]\nenabled = true\n',
    );
    const cacheDirectory = join(
      temporaryHome,
      "plugins",
      "cache",
      "openai-curated-remote",
      "build-web-apps",
      "fixture-cache",
      ".codex-plugin",
    );
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, "plugin.json"), "{}\n");

    const manager = new ReadOnlyCodexPluginStatus(temporaryHome);
    expect(await manager.status(["build-web-apps@openai-curated"])).toEqual({
      "build-web-apps@openai-curated": "installed",
    });
    expect(manager.getObservedIdentities()).toEqual({
      "build-web-apps@openai-curated": "build-web-apps@openai-curated-remote",
    });
  });

  test("reports missing providers for a fresh Codex home without config.toml", async () => {
    temporaryHome = await mkdtemp(join(tmpdir(), "holycodex-fresh-plugin-status-"));
    const manager = new ReadOnlyCodexPluginStatus(temporaryHome);
    expect(await manager.status(["browser@openai-bundled", "holycodex@holycodex"])).toEqual({
      "browser@openai-bundled": "missing",
      "holycodex@holycodex": "missing",
    });
    expect(manager.getObservedIdentities()).toEqual({});
  });
});
