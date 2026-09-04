// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SourceManifestSchema, validateSource } from "../packages/plugin/src/index.ts";
import { assertBuildUploadDirectory, listSafeArtifactEntries } from "./artifact-security.ts";
import { allowlistedEnvironment, DEFAULT_COMMAND_ENVIRONMENT_KEYS, runChecked } from "./process.ts";
import { readCanonicalVersion } from "../packages/cli/src/manifest.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const distRoot = join(workspaceRoot, "packages/cli/dist");
const distAssets = join(distRoot, "assets");
const pluginAssets = join(workspaceRoot, "packages/plugin/assets");

export async function runPackageBuild(): Promise<void> {
  await ensureCodexGenerated();
  // Validate the source tree before copying it into the public build. The
  // source validator rejects undeclared, linked, generated, and secret-like
  // files; the artifact policy adds the broader local-store guard used at
  // package/release boundaries.
  await validateSource(pluginAssets);
  await listSafeArtifactEntries(pluginAssets, "the plugin source");
  await runChecked(["vp", "pack"], {
    cwd: workspaceRoot,
    env: allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS),
  });
  const packagedPlugin = join(distAssets, "plugin");
  await rm(packagedPlugin, { recursive: true, force: true });
  await cp(pluginAssets, packagedPlugin, { recursive: true, dereference: true });
  const pluginManifestPath = join(packagedPlugin, ".codex-plugin/plugin.json");
  const rawPluginManifest: unknown = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  const parsedPluginManifest = Schema.decodeUnknownEither(SourceManifestSchema, {
    onExcessProperty: "preserve",
  })(rawPluginManifest);
  if (Either.isLeft(parsedPluginManifest)) {
    throw new Error(
      `The packaged plugin manifest is invalid: ${String(parsedPluginManifest.left)}`,
    );
  }
  const pluginManifest = {
    ...parsedPluginManifest.right,
    version: await readCanonicalVersion(),
  };
  await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);
  await cp(join(packagedPlugin, ".codex-plugin/plugin.json"), join(packagedPlugin, "plugin.json"));
  await rm(join(packagedPlugin, ".codex-plugin"), { recursive: true, force: true });
  await assertBuildUploadDirectory(distRoot);
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
