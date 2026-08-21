// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runChecked } from "./process.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const distRoot = join(workspaceRoot, "packages/cli/dist");
const distAssets = join(distRoot, "assets");
const distLegal = join(distRoot, "legal");
const pluginAssets = join(workspaceRoot, "packages/plugin/assets");

export async function runPackageBuild(): Promise<void> {
  await runChecked(["vp", "pack"], { cwd: workspaceRoot, env: process.env });
  await rm(join(distAssets, "plugin"), { recursive: true, force: true });
  await cp(pluginAssets, distAssets, { recursive: true, dereference: true });
  await mkdir(distLegal, { recursive: true });
  for (const file of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"] as const) {
    await cp(join(workspaceRoot, file), join(distLegal, file), { dereference: true });
  }
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
