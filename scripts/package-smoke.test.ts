// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateInstalledPluginSource } from "./package-smoke.ts";

const pluginAssets = resolve(import.meta.dirname, "../packages/plugin/assets");

test("validates installed plugin assets beside the native helper payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "holycodex-package-assets-"));
  try {
    const installedAssets = join(root, "assets");
    await cp(pluginAssets, installedAssets, { recursive: true, dereference: false });
    await mkdir(join(installedAssets, "safe-filesystem"));
    await writeFile(join(installedAssets, "safe-filesystem", "native-helper.bin"), "native\n");

    await expect(
      validateInstalledPluginSource(installedAssets, join(root, "validation")),
    ).resolves.toBeUndefined();

    await writeFile(join(installedAssets, "unexpected.txt"), "unexpected\n");
    await expect(
      validateInstalledPluginSource(installedAssets, join(root, "invalid-validation")),
    ).rejects.toThrow("undeclared package entry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
