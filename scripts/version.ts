// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

const VersionText = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const VersionTargetText = /^(?:patch|minor|0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const strictParseOptions = { onExcessProperty: "error" } as const;
const manifestParseOptions = { onExcessProperty: "preserve" } as const;
const VersionArgumentsSchema = Schema.Struct({
  target: Schema.String.pipe(Schema.pattern(VersionTargetText)),
  dryRun: Schema.Boolean,
});
const CliManifestSchema = Schema.Struct({
  name: Schema.Literal("holycodex"),
  version: Schema.String.pipe(Schema.pattern(VersionText)),
});

type VersionArguments = typeof VersionArgumentsSchema.Type;
type CliManifest = typeof CliManifestSchema.Type;

const rawArguments = Bun.argv.slice(2);
const dryRun = rawArguments.includes("--dry-run");
const positionalArguments = rawArguments.filter((argument) => argument !== "--dry-run");

if (positionalArguments.length !== 1) {
  throw new Error("Usage: bun scripts/version.ts <0.x.y|patch|minor> [--dry-run]");
}

const targetArgument = positionalArguments[0];
if (targetArgument === undefined) {
  throw new Error("Usage: bun scripts/version.ts <0.x.y|patch|minor> [--dry-run]");
}
const parsedArguments = Schema.decodeUnknownEither(
  VersionArgumentsSchema,
  strictParseOptions,
)({
  target: targetArgument,
  dryRun,
});

if (Either.isLeft(parsedArguments)) {
  throw new Error(
    `${parsedArguments.left.message}\nUsage: bun scripts/version.ts <0.x.y|patch|minor> [--dry-run]`,
  );
}

const cliManifestPath = `${import.meta.dir}/../packages/cli/package.json`;
const pluginManifestPath = `${import.meta.dir}/../packages/plugin/assets/.codex-plugin/plugin.json`;
const rawManifest: unknown = await Bun.file(cliManifestPath).json();
const currentManifest = Schema.decodeUnknownEither(
  CliManifestSchema,
  manifestParseOptions,
)(rawManifest);

if (Either.isLeft(currentManifest)) {
  throw new Error(currentManifest.left.message);
}

const currentVersion = currentManifest.right.version;
const nextVersion = resolveVersion(parsedArguments.right, currentVersion);

if (!parsedArguments.right.dryRun) {
  const pluginManifest: unknown = await Bun.file(pluginManifestPath).json();
  const parsedPluginManifest = Schema.decodeUnknownEither(
    CliManifestSchema,
    manifestParseOptions,
  )(pluginManifest);
  if (Either.isLeft(parsedPluginManifest)) {
    throw new Error(parsedPluginManifest.left.message);
  }
  await Bun.write(
    cliManifestPath,
    `${JSON.stringify({ ...currentManifest.right, version: nextVersion }, null, 2)}\n`,
  );
  await Bun.write(
    pluginManifestPath,
    `${JSON.stringify({ ...parsedPluginManifest.right, version: nextVersion }, null, 2)}\n`,
  );
}

console.log(
  `${parsedArguments.right.dryRun ? "would set" : "set"} holycodex from ${currentVersion} to ${nextVersion}`,
);

function resolveVersion(
  arguments_: VersionArguments,
  current: CliManifest["version"],
): CliManifest["version"] {
  if (arguments_.target !== "patch" && arguments_.target !== "minor") {
    return arguments_.target;
  }

  const [, minorText, patchText] = current.split(".");
  const minor = Number(minorText);
  const patch = Number(patchText);
  const nextMinor = arguments_.target === "minor" ? minor + 1 : minor;
  const nextPatch = arguments_.target === "minor" ? 0 : patch + 1;

  return `0.${nextMinor}.${nextPatch}`;
}
