// SPDX-License-Identifier: Apache-2.0

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SourceManifestSchema, validateSource } from "../packages/plugin/src/index.ts";
import { assertBuildUploadDirectory, listSafeArtifactEntries } from "./artifact-security.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";
import { readCanonicalVersion } from "./release-version.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const distRoot = join(workspaceRoot, "packages/cli/dist");
const distAssets = join(distRoot, "assets");
const pluginAssets = join(workspaceRoot, "packages/plugin/assets");

const buildEntries = [
  {
    source: join(workspaceRoot, "packages/cli/src/index.ts"),
    output: join(distRoot, "index.js"),
  },
  {
    source: join(workspaceRoot, "packages/agent/src/index.ts"),
    output: join(distRoot, "agent.js"),
  },
] as const;

/** Builds the public CLI and model-facing agent bundles, then stages plugin assets. */
export function runPackageBuild() {
  return Effect.gen(function* () {
    yield* ensureCodexGenerated();
    // Validate the source tree before copying it into the public build. The
    // source validator rejects undeclared, linked, generated, and secret-like
    // files; the artifact policy adds the broader local-store guard used at
    // package/release boundaries.
    yield* Effect.tryPromise(() => validateSource(pluginAssets));
    yield* Effect.tryPromise(() => listSafeArtifactEntries(pluginAssets, "the plugin source"));
    yield* Effect.tryPromise(() => rm(distRoot, { recursive: true, force: true }));
    for (const entry of buildEntries) {
      const result = yield* Effect.tryPromise(() =>
        Bun.build({
          entrypoints: [entry.source],
          outdir: distRoot,
          naming: basename(entry.output),
          target: "bun",
          format: "esm",
          splitting: false,
          minify: true,
          banner: "#!/usr/bin/env bun",
          external: ["@opentui/core"],
        }),
      );
      if (!result.success) {
        return yield* Effect.fail(
          new Error(
            `Bun build failed: ${result.logs.map((log) => log.message).join("\n") || "unknown error"}`,
          ),
        );
      }
    }
    const packagedPlugin = join(distAssets, "plugin");
    yield* Effect.tryPromise(() => rm(packagedPlugin, { recursive: true, force: true }));
    yield* Effect.tryPromise(() =>
      cp(pluginAssets, packagedPlugin, { recursive: true, dereference: true }),
    );
    const pluginManifestPath = join(packagedPlugin, ".codex-plugin/plugin.json");
    const manifestText = yield* Effect.tryPromise(() => readFile(pluginManifestPath, "utf8"));
    const pluginManifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SourceManifestSchema),
      { onExcessProperty: "ignore" },
    )(manifestText);
    const version = yield* readCanonicalVersion();
    yield* Effect.tryPromise(() =>
      writeFile(pluginManifestPath, `${JSON.stringify({ ...pluginManifest, version }, null, 2)}\n`),
    );
    yield* Effect.tryPromise(() =>
      cp(join(packagedPlugin, ".codex-plugin/plugin.json"), join(packagedPlugin, "plugin.json")),
    );
    yield* Effect.tryPromise(() => rm(join(packagedPlugin, ".codex-plugin"), { recursive: true }));
    yield* Effect.tryPromise(() => assertBuildUploadDirectory(distRoot));
  });
}

if (import.meta.main) {
  await Effect.runPromise(
    runPackageBuild().pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          console.log(JSON.stringify({ status: "verified", output: "packages/cli/dist" })),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error(JSON.stringify({ status: "failed", message: Cause.pretty(cause) }));
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
