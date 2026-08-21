// SPDX-License-Identifier: Apache-2.0

const STABLE_VERSION = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u;
const STABLE_TAG = /^v([0-9]+\.[0-9]+\.[0-9]+)$/u;
const SHA = /^[0-9a-f]{7,64}$/u;

export type DevReleaseIdentity = Readonly<{
  readonly version: string;
  readonly tag: string;
}>;

export function assertStableVersion(value: string): string {
  if (!STABLE_VERSION.test(value)) {
    throw new Error("The canonical package version must be stable X.Y.Z semver.");
  }
  return value;
}

export function stableVersionFromTag(tag: string, canonicalVersion: string): string {
  const match = STABLE_TAG.exec(tag);
  if (match?.[1] === undefined) {
    throw new Error("Stable releases require an exact vX.Y.Z tag.");
  }
  const version = assertStableVersion(canonicalVersion);
  if (match[1] !== version) {
    throw new Error(`Release tag ${tag} does not match canonical version ${version}.`);
  }
  return version;
}

export function devReleaseIdentity(
  canonicalVersion: string,
  runNumber: string,
  runAttempt: string,
  commitSha: string,
): DevReleaseIdentity {
  const version = assertStableVersion(canonicalVersion);
  if (!/^[1-9][0-9]*$/u.test(runNumber) || !/^[1-9][0-9]*$/u.test(runAttempt)) {
    throw new Error("The GitHub Actions run identity is invalid.");
  }
  const sha = commitSha.toLowerCase();
  if (!SHA.test(sha)) {
    throw new Error("The release commit SHA is invalid.");
  }
  const shortSha = sha.slice(0, 12);
  return {
    version: `${version}-dev.${runNumber}.${runAttempt}.${shortSha}`,
    tag: `dev-${version}.${runNumber}.${runAttempt}.${shortSha}`,
  };
}

async function main(): Promise<void> {
  const [mode, canonicalVersion, identity, attemptOrSha, maybeSha] = Bun.argv.slice(2);
  if (mode === "stable") {
    if (canonicalVersion === undefined || identity === undefined) throw new Error("Missing release arguments.");
    console.log(JSON.stringify({ version: stableVersionFromTag(identity, canonicalVersion), tag: identity }));
    return;
  }
  if (mode === "dev") {
    if (
      canonicalVersion === undefined ||
      identity === undefined ||
      attemptOrSha === undefined ||
      maybeSha === undefined
    ) {
      throw new Error("Missing release arguments.");
    }
    console.log(JSON.stringify(devReleaseIdentity(canonicalVersion, identity, attemptOrSha, maybeSha)));
    return;
  }
  throw new Error("Release mode must be dev or stable.");
}

if (import.meta.main) {
  await main();
}
