// SPDX-License-Identifier: Apache-2.0

import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runChecked } from "./process.ts";
import { buildSafeFilesystemArtifact } from "./build-safe-filesystem.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const distRoot = join(workspaceRoot, "packages/cli/dist");
const distAssets = join(distRoot, "assets");
const pluginAssets = join(workspaceRoot, "packages/plugin/assets");

export async function runPackageBuild(): Promise<void> {
  await runChecked(["vp", "pack"], { cwd: workspaceRoot, env: process.env });
  const packagedPlugin = join(distAssets, "plugin");
  await rm(packagedPlugin, { recursive: true, force: true });
  await cp(pluginAssets, packagedPlugin, { recursive: true, dereference: true });
  await cp(join(packagedPlugin, ".codex-plugin/plugin.json"), join(packagedPlugin, "plugin.json"));
  await rm(join(packagedPlugin, ".codex-plugin"), { recursive: true, force: true });
  await buildSafeFilesystemArtifact(join(distAssets, "safe-filesystem"));
}

if (import.meta.main) {
  try {
    await runPackageBuild();
    console.log(JSON.stringify({ status: "verified", output: "packages/cli/dist" }));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "package build failed",
      }),
    );
    process.exitCode = 1;
  }
}
