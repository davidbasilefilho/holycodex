// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";

const VersionText = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const VersionTargetText = /^(?:patch|minor|0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const VersionArguments = type({
  target: VersionTargetText,
  dryRun: "boolean",
});
const CliManifest = type({
  name: "'holycodex'",
  version: VersionText,
});

type VersionArguments = typeof VersionArguments.infer;
type CliManifest = typeof CliManifest.infer;

const rawArguments = Bun.argv.slice(2);
const dryRun = rawArguments.includes("--dry-run");
const positionalArguments = rawArguments.filter((argument) => argument !== "--dry-run");

if (positionalArguments.length !== 1) {
  throw new Error("Usage: bun scripts/version.ts <0.x.y|patch|minor> [--dry-run]");
}

const targetArgument = positionalArguments[0];
const parsedArguments = VersionArguments({
  target: targetArgument,
  dryRun,
});

if (parsedArguments instanceof type.errors) {
  throw new Error(
    `${parsedArguments.summary}\nUsage: bun scripts/version.ts <0.x.y|patch|minor> [--dry-run]`,
  );
}

const cliManifestPath = `${import.meta.dir}/../packages/cli/package.json`;
const currentManifest = CliManifest(await Bun.file(cliManifestPath).json());

if (currentManifest instanceof type.errors) {
  throw new Error(currentManifest.summary);
}

const currentVersion = currentManifest.version;
const nextVersion = resolveVersion(parsedArguments, currentVersion);

if (!parsedArguments.dryRun) {
  await Bun.write(
    cliManifestPath,
    `${JSON.stringify({ ...currentManifest, version: nextVersion }, null, 2)}\n`,
  );
}

console.log(
  `${parsedArguments.dryRun ? "would set" : "set"} holycodex from ${currentVersion} to ${nextVersion}`,
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
