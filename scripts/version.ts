// SPDX-License-Identifier: Apache-2.0

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { CanonicalVersionSchema, resolveCanonicalVersion } from "../packages/core/src/version.ts";
import { SourceManifestSchema } from "../packages/plugin/src/schemas.ts";
import { decodeVersionedManifest } from "./release-version.ts";

const VersionTargetSchema = Schema.Union([
  Schema.Literals(["patch", "minor"]),
  CanonicalVersionSchema,
]);
const VersionArgumentsSchema = Schema.Union([
  Schema.Tuple([VersionTargetSchema]),
  Schema.Tuple([Schema.Literals(["--dry-run"]), VersionTargetSchema]),
  Schema.Tuple([VersionTargetSchema, Schema.Literals(["--dry-run"])]),
]);
type VersionTarget = typeof VersionTargetSchema.Type;

const cliManifestPath = `${import.meta.dir}/../packages/cli/package.json`;
const pluginManifestPath = `${import.meta.dir}/../packages/plugin/assets/.codex-plugin/plugin.json`;

/** Validate and optionally update the canonical CLI and plugin manifest versions. */
export function runVersionUpdate(argv: readonly string[] = Bun.argv.slice(2)) {
  return Effect.gen(function* () {
    const parsedArguments = yield* Schema.decodeUnknownEffect(VersionArgumentsSchema)(argv);
    const dryRun = parsedArguments.includes("--dry-run");
    const target = parsedArguments[0] === "--dry-run" ? parsedArguments[1] : parsedArguments[0];
    const rawManifest = yield* Effect.tryPromise(() => Bun.file(cliManifestPath).json());
    const currentManifest = yield* decodeManifest(rawManifest);
    const currentVersion = currentManifest.version;
    const nextVersion = resolveVersion(target as VersionTarget, currentVersion);

    if (!dryRun) {
      const pluginInput = yield* Effect.tryPromise(() => Bun.file(pluginManifestPath).json());
      const pluginManifest = yield* decodeManifest(pluginInput, SourceManifestSchema);
      yield* Effect.tryPromise(() =>
        Bun.write(
          cliManifestPath,
          `${JSON.stringify({ ...currentManifest, version: nextVersion }, null, 2)}\n`,
        ),
      );
      yield* Effect.tryPromise(() =>
        Bun.write(
          pluginManifestPath,
          `${JSON.stringify({ ...pluginManifest, version: nextVersion }, null, 2)}\n`,
        ),
      );
    }

    console.log(
      `${dryRun ? "would set" : "set"} holycodex from ${currentVersion} to ${nextVersion}`,
    );
    return { currentVersion, nextVersion, dryRun };
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error instanceof Error ? error.message : "version update failed");
        process.exitCode = 1;
      }),
    ),
  );
}

function decodeManifest(
  input: unknown,
  schema?: Schema.Decoder<Readonly<{ name: string; version: string }>>,
) {
  const decoded = decodeVersionedManifest(input, schema);
  return Result.isSuccess(decoded) ? Effect.succeed(decoded.success) : Effect.fail(decoded.failure);
}

function resolveVersion(target: VersionTarget, current: string): string {
  return resolveCanonicalVersion(target, current);
}

if (import.meta.main) {
  await Effect.runPromise(runVersionUpdate());
}
