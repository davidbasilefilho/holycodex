// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { assertReleaseOutputDirectory, assertSafeArtifactFile } from "./artifact-security.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";
import type { PackageReleaseOptions } from "./package-verification.ts";
import {
  allowlistedEnvironment,
  DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  redactDiagnostics,
  runCommand,
  runChecked,
  withTemporaryDirectory,
  writeJson,
} from "./process.ts";
import {
  assertReleaseVersion,
  BaseVersionSchema,
  readCanonicalVersion,
  ReleaseChannelSchema,
  ReleaseVersionSchema,
  Sha256Schema,
  SourceShaSchema,
  type ReleaseChannel,
} from "./release-version.ts";

const ReleaseStampSchema = Schema.Struct({
  schemaVersion: Schema.Literal("holycodex-release-v1"),
  channel: ReleaseChannelSchema,
  sourceSha: SourceShaSchema,
});
const ArtifactMetadataSchema = Schema.Struct({
  schemaVersion: Schema.Literal("holycodex-artifact-v1"),
  name: Schema.Literal("holycodex"),
  baseVersion: BaseVersionSchema,
  version: ReleaseVersionSchema,
  channel: ReleaseChannelSchema,
  sourceSha: SourceShaSchema,
  tarball: Schema.String.pipe(Schema.pattern(/^holycodex-[^/\\]+\.tgz$/u)),
  tarballSha256: Sha256Schema,
  entries: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  verificationCommands: Schema.Array(Schema.String),
});
const RegistryMetadataSchema = Schema.Struct({
  name: Schema.Literal("holycodex"),
  version: ReleaseVersionSchema,
  release: ReleaseStampSchema,
  dist: Schema.Struct({
    tarball: Schema.String.pipe(Schema.pattern(/^https?:\/\//u)),
  }),
});
const GitHubReleaseSchema = Schema.Struct({
  tagName: Schema.String,
  isPrerelease: Schema.Boolean,
  isDraft: Schema.Boolean,
  body: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const ReleaseMarkerSchema = Schema.Struct({
  schemaVersion: Schema.Literal("holycodex-artifact-v1"),
  name: Schema.Literal("holycodex"),
  version: ReleaseVersionSchema,
  channel: ReleaseChannelSchema,
  sourceSha: SourceShaSchema,
  tarball: Schema.String.pipe(Schema.pattern(/^holycodex-[^/\\]+\.tgz$/u)),
  tarballSha256: Sha256Schema,
});
const ArtifactPathSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096));
const ArgumentsSchema = Schema.Array(Schema.String);

type ArtifactMetadata = typeof ArtifactMetadataSchema.Type;

export async function createReleaseArtifact(
  outputDirectory: string,
  options: PackageReleaseOptions,
): Promise<ArtifactMetadata> {
  const { packPublicPackage, verifyPublicPackage } = await loadPackageVerification();
  const canonicalVersion = await readCanonicalVersion();
  assertReleaseVersion(canonicalVersion, options.channel, options.version);
  const output = resolve(decode(ArtifactPathSchema, outputDirectory, "the artifact directory"));
  await mkdir(output, { recursive: true });
  return await withTemporaryDirectory("holycodex-package-release", async (temporaryRoot) => {
    const packed = await packPublicPackage(temporaryRoot, options);
    const verification = await verifyPublicPackage(packed);
    const metadata: ArtifactMetadata = {
      schemaVersion: "holycodex-artifact-v1",
      name: "holycodex",
      baseVersion: packed.baseVersion,
      version: packed.packageVersion,
      channel: options.channel,
      sourceSha: options.sourceSha,
      tarball: packed.tarball,
      tarballSha256: packed.tarballSha256,
      entries: [...packed.entries],
      verificationCommands: [...verification.commands],
    };
    await cp(packed.tarballPath, join(output, packed.tarball));
    await writeJson(join(output, "release-metadata.json"), metadata);
    await assertReleaseOutputDirectory(output, packed.tarball);
    return metadata;
  });
}

export async function verifyReleaseArtifact(
  outputDirectory: string,
  version: string,
  channel: ReleaseChannel,
  sourceSha: string,
  expectedSha256: string,
): Promise<ArtifactMetadata> {
  const { assertPackedEntries, sha256File } = await loadPackageVerification();
  const output = resolve(decode(ArtifactPathSchema, outputDirectory, "the artifact directory"));
  const metadata = await readArtifactMetadata(output);
  await assertReleaseOutputDirectory(output, metadata.tarball);
  const canonicalVersion = await readCanonicalVersion();
  assertReleaseVersion(canonicalVersion, channel, version);
  assert(metadata.baseVersion === canonicalVersion, "the artifact base version is not canonical");
  assert(metadata.version === version, "the artifact version does not match the release version");
  assert(metadata.channel === channel, "the artifact channel does not match the release channel");
  assert(metadata.sourceSha === sourceSha, "the artifact source SHA does not match the checkout");
  assert(
    metadata.tarball === `holycodex-${version}.tgz`,
    "the artifact tarball name does not match the release version",
  );
  assert(
    metadata.tarballSha256 === expectedSha256,
    "the artifact digest does not match the validated release output",
  );
  const tarballPath = join(output, metadata.tarball);
  await requireFile(tarballPath, "the downloaded release tarball");
  await assertSafeArtifactFile(tarballPath, metadata.tarball, "the release tarball");
  const actualSha256 = await sha256File(tarballPath);
  assert(actualSha256 === metadata.tarballSha256, "the release tarball digest is not stable");
  await assertPackedEntries(tarballPath, metadata.entries);
  return metadata;
}

export async function checkNpmPublication(
  outputDirectory: string,
  version: string,
  channel: ReleaseChannel,
  sourceSha: string,
  expectedSha256: string,
): Promise<"absent" | "matching"> {
  const metadata = await verifyReleaseArtifact(
    outputDirectory,
    version,
    channel,
    sourceSha,
    expectedSha256,
  );
  const response = await fetch(
    `https://registry.npmjs.org/holycodex/${encodeURIComponent(version)}`,
  );
  if (response.status === 404) {
    return "absent";
  }
  if (!response.ok) {
    throw new Error(`npm registry lookup failed with HTTP ${response.status}.`);
  }
  const raw: unknown = await response.json();
  const published = decode(RegistryMetadataSchema, raw, "the npm publication metadata");
  assert(
    published.version === version,
    "the existing npm version does not match the release version",
  );
  assert(
    published.release.channel === channel && published.release.sourceSha === sourceSha,
    "the existing npm version has a different channel or source SHA",
  );
  const tarballResponse = await fetch(published.dist.tarball);
  if (!tarballResponse.ok) {
    throw new Error(
      `the existing npm tarball could not be downloaded: HTTP ${tarballResponse.status}`,
    );
  }
  const bytes = new Uint8Array(await tarballResponse.arrayBuffer());
  const actualSha256 = await sha256Bytes(bytes);
  assert(
    actualSha256 === metadata.tarballSha256,
    "the existing npm version has a different artifact identity",
  );
  return "matching";
}

export async function checkGitHubPublication(
  outputDirectory: string,
  version: string,
  channel: ReleaseChannel,
  sourceSha: string,
  expectedSha256: string,
  repository: string,
): Promise<"absent" | "matching"> {
  const metadata = await verifyReleaseArtifact(
    outputDirectory,
    version,
    channel,
    sourceSha,
    expectedSha256,
  );
  const tag = `v${version}`;
  const githubEnvironment = allowlistedEnvironment([
    ...DEFAULT_COMMAND_ENVIRONMENT_KEYS,
    "GH_TOKEN",
  ]);
  const viewed = await runCommand(
    [
      "gh",
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "tagName,isPrerelease,isDraft,body,assets",
    ],
    { env: githubEnvironment },
  );
  if (viewed.exitCode !== 0) {
    if (/(?:not found|HTTP 404|404 Not Found)/iu.test(viewed.stderr)) {
      return "absent";
    }
    throw new Error(
      `GitHub release lookup failed: ${redactDiagnostics(viewed.stderr || viewed.stdout, githubEnvironment)}`,
    );
  }
  const raw: unknown = JSON.parse(viewed.stdout);
  const release = decode(GitHubReleaseSchema, raw, "the GitHub release metadata");
  assert(release.tagName === tag, "the existing GitHub release has a different tag");
  assert(!release.isDraft, "the existing GitHub release is still a draft");
  assert(
    release.isPrerelease === (channel === "dev"),
    "the existing GitHub release has the wrong prerelease state",
  );
  const marker = parseReleaseMarker(release.body);
  assert(
    marker.version === metadata.version,
    "the existing GitHub release has a different version",
  );
  assert(
    marker.channel === metadata.channel,
    "the existing GitHub release has a different channel",
  );
  assert(
    marker.sourceSha === metadata.sourceSha,
    "the existing GitHub release has a different source SHA",
  );
  assert(
    marker.tarballSha256 === metadata.tarballSha256,
    "the existing GitHub release has a different artifact identity",
  );
  assert(
    release.assets.some((asset) => asset.name === metadata.tarball),
    "the existing GitHub release is missing the validated tarball",
  );
  await withTemporaryDirectory("holycodex-release-verify", async (directory) => {
    await runChecked(
      [
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--pattern",
        metadata.tarball,
        "--dir",
        directory,
        "--clobber",
      ],
      { env: githubEnvironment },
    );
    const downloaded = join(directory, metadata.tarball);
    const { sha256File } = await loadPackageVerification();
    assert(
      (await sha256File(downloaded)) === metadata.tarballSha256,
      "the existing GitHub asset has a different artifact identity",
    );
  });
  return "matching";
}

export async function writeReleaseNotes(outputDirectory: string, notesPath: string): Promise<void> {
  const metadata = await readArtifactMetadata(resolve(outputDirectory));
  const marker = JSON.stringify({
    schemaVersion: metadata.schemaVersion,
    name: metadata.name,
    version: metadata.version,
    channel: metadata.channel,
    sourceSha: metadata.sourceSha,
    tarball: metadata.tarball,
    tarballSha256: metadata.tarballSha256,
  });
  const notes = [
    `<!-- holycodex-release: ${marker} -->`,
    `Validated ${metadata.channel} artifact for ${metadata.name}@${metadata.version}.`,
    `Source SHA: ${metadata.sourceSha}`,
    `Tarball SHA-256: ${metadata.tarballSha256}`,
    "",
  ].join("\n");
  await writeFile(resolve(decode(ArtifactPathSchema, notesPath, "the release notes path")), notes, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function loadPackageVerification(): Promise<typeof import("./package-verification.ts")> {
  await ensureCodexGenerated();
  return await import("./package-verification.ts");
}

async function readArtifactMetadata(outputDirectory: string): Promise<ArtifactMetadata> {
  const raw: unknown = JSON.parse(
    await readFile(join(outputDirectory, "release-metadata.json"), "utf8"),
  );
  return decode(ArtifactMetadataSchema, raw, "the release artifact metadata");
}

function parseReleaseMarker(body: string): typeof ReleaseMarkerSchema.Type {
  const match = body.match(/<!--\s*holycodex-release:\s*(\{[^\r\n]+\})\s*-->/u);
  if (match?.[1] === undefined) {
    throw new Error("the GitHub release is missing its HolyCodex identity marker");
  }
  const raw: unknown = JSON.parse(match[1]);
  return decode(ReleaseMarkerSchema, raw, "the GitHub release identity marker");
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    await readFile(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function decode<A>(schema: Schema.Schema<A>, value: unknown, label: string): A {
  const parsed = Schema.decodeUnknownEither(schema)(value);
  if (Either.isLeft(parsed)) {
    throw new Error(`${label} is invalid: ${String(parsed.left)}`);
  }
  return parsed.right;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function argument(args: readonly string[], index: number, label: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function expectArgumentCount(args: readonly string[], count: number): void {
  if (args.length !== count) {
    throw new Error("Invalid release packaging arguments.");
  }
}

function releaseOptions(args: readonly string[], start: number): PackageReleaseOptions {
  const channel = decode(
    ReleaseChannelSchema,
    argument(args, start + 1, "release channel"),
    "the release channel",
  );
  return {
    version: decode(
      ReleaseVersionSchema,
      argument(args, start, "release version"),
      "the release version",
    ),
    channel,
    sourceSha: decode(SourceShaSchema, argument(args, start + 2, "source SHA"), "the source SHA"),
  };
}

if (import.meta.main) {
  try {
    const parsed = decode(ArgumentsSchema, Bun.argv.slice(2), "release packaging arguments");
    const command = argument(parsed, 0, "release packaging command");
    if (command === "create") {
      expectArgumentCount(parsed, 5);
      const result = await createReleaseArtifact(
        argument(parsed, 1, "artifact directory"),
        releaseOptions(parsed, 2),
      );
      console.log(JSON.stringify(result));
    } else if (command === "verify") {
      expectArgumentCount(parsed, 6);
      const result = await verifyReleaseArtifact(
        argument(parsed, 1, "artifact directory"),
        releaseOptions(parsed, 2).version,
        releaseOptions(parsed, 2).channel,
        releaseOptions(parsed, 2).sourceSha,
        decode(
          Sha256Schema,
          argument(parsed, 5, "expected artifact digest"),
          "the expected artifact digest",
        ),
      );
      console.log(JSON.stringify({ status: "verified", ...result }));
    } else if (command === "digest") {
      expectArgumentCount(parsed, 2);
      console.log(
        (await readArtifactMetadata(resolve(argument(parsed, 1, "artifact directory"))))
          .tarballSha256,
      );
    } else if (command === "notes") {
      expectArgumentCount(parsed, 3);
      await writeReleaseNotes(
        argument(parsed, 1, "artifact directory"),
        argument(parsed, 2, "notes path"),
      );
      console.log("written");
    } else if (command === "check-npm") {
      expectArgumentCount(parsed, 6);
      const options = releaseOptions(parsed, 2);
      console.log(
        await checkNpmPublication(
          argument(parsed, 1, "artifact directory"),
          options.version,
          options.channel,
          options.sourceSha,
          decode(
            Sha256Schema,
            argument(parsed, 5, "expected artifact digest"),
            "the expected artifact digest",
          ),
        ),
      );
    } else if (command === "check-github") {
      expectArgumentCount(parsed, 7);
      const options = releaseOptions(parsed, 2);
      console.log(
        await checkGitHubPublication(
          argument(parsed, 1, "artifact directory"),
          options.version,
          options.channel,
          options.sourceSha,
          decode(
            Sha256Schema,
            argument(parsed, 5, "expected artifact digest"),
            "the expected artifact digest",
          ),
          argument(parsed, 6, "GitHub repository"),
        ),
      );
    } else {
      throw new Error(
        "Usage: bun scripts/package-release.ts <create|verify|digest|notes|check-npm|check-github> ...",
      );
    }
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "release packaging failed",
      }),
    );
    process.exitCode = 1;
  }
}
