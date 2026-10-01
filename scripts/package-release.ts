// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { assertReleaseOutputDirectory, assertSafeArtifactFile } from "./artifact-security.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";
import type { PackageReleaseOptions } from "./package-verification.ts";
import {
  allowlistedEnvironment,
  DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  redactDiagnostics,
  runCommandEffect,
  runCheckedEffect,
  withTemporaryDirectoryEffect,
  writeJson,
} from "./process.ts";
import {
  assertReleaseVersion,
  BaseVersionSchema,
  baseVersionFromRelease,
  readCanonicalVersion,
  ReleaseChannelSchema,
  ReleaseVersionSchema,
  Sha256Schema,
  SourceShaSchema,
  type ReleaseChannel,
} from "./release-version.ts";

const ReleaseStampSchema = Schema.Struct({
  schemaVersion: Schema.Literals(["holycodex-release-v1"]),
  channel: ReleaseChannelSchema,
  sourceSha: SourceShaSchema,
});
const ArtifactMetadataSchema = Schema.Struct({
  schemaVersion: Schema.Literals(["holycodex-artifact-v1"]),
  name: Schema.Literals(["holycodex"]),
  baseVersion: BaseVersionSchema,
  version: ReleaseVersionSchema,
  channel: ReleaseChannelSchema,
  sourceSha: SourceShaSchema,
  tarball: Schema.String.check(Schema.isPattern(/^holycodex-[^/\\]+\.tgz$/u)),
  tarballSha256: Sha256Schema,
  entries: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  verificationCommands: Schema.Array(Schema.String),
});
const RegistryMetadataSchema = Schema.Struct({
  name: Schema.Literals(["holycodex"]),
  version: ReleaseVersionSchema,
  release: ReleaseStampSchema,
  dist: Schema.Struct({
    tarball: Schema.String.check(Schema.isPattern(/^https?:\/\//u)),
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
  schemaVersion: Schema.Literals(["holycodex-artifact-v1"]),
  name: Schema.Literals(["holycodex"]),
  version: ReleaseVersionSchema,
  channel: ReleaseChannelSchema,
  sourceSha: SourceShaSchema,
  tarball: Schema.String.check(Schema.isPattern(/^holycodex-[^/\\]+\.tgz$/u)),
  tarballSha256: Sha256Schema,
});
const ArtifactPathSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const ArgumentsSchema = Schema.Array(Schema.String);

type ArtifactMetadata = typeof ArtifactMetadataSchema.Type;

/** Build, package, and verify a release artifact for the requested version. */
export function createReleaseArtifact(
  outputDirectory: string,
  options: PackageReleaseOptions,
): Promise<ArtifactMetadata> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { packPublicPackage, verifyPublicPackage } = yield* loadPackageVerificationEffect();
      const canonicalVersion = yield* readCanonicalVersion();
      assertReleaseVersion(canonicalVersion, options.channel, options.version);
      const output = resolve(decode(ArtifactPathSchema, outputDirectory, "the artifact directory"));
      yield* promiseEffect(() => mkdir(output, { recursive: true }));
      return yield* withTemporaryDirectoryEffect("holycodex-package-release", (temporaryRoot) =>
        Effect.gen(function* () {
          const packed = yield* promiseEffect(() => packPublicPackage(temporaryRoot, options));
          const verification = yield* promiseEffect(() => verifyPublicPackage(packed));
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
          yield* promiseEffect(() => cp(packed.tarballPath, join(output, packed.tarball)));
          yield* promiseEffect(() => writeJson(join(output, "release-metadata.json"), metadata));
          yield* promiseEffect(() => assertReleaseOutputDirectory(output, packed.tarball));
          return metadata;
        }),
      );
    }),
  );
}

/** Verify release metadata, tarball identity, and packaged entries. */
export function verifyReleaseArtifact(
  outputDirectory: string,
  version: string,
  channel: ReleaseChannel,
  sourceSha: string,
  expectedSha256: string,
): Promise<ArtifactMetadata> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { assertPackedEntries, sha256File } = yield* loadPackageVerificationEffect();
      const output = resolve(decode(ArtifactPathSchema, outputDirectory, "the artifact directory"));
      const metadata = yield* readArtifactMetadataEffect(output);
      yield* promiseEffect(() => assertReleaseOutputDirectory(output, metadata.tarball));
      const canonicalVersion = yield* readCanonicalVersion();
      assertReleaseVersion(canonicalVersion, channel, version);
      assert(
        metadata.baseVersion === baseVersionFromRelease(canonicalVersion),
        "the artifact base version is not canonical",
      );
      assert(
        metadata.version === version,
        "the artifact version does not match the release version",
      );
      assert(
        metadata.channel === channel,
        "the artifact channel does not match the release channel",
      );
      assert(
        metadata.sourceSha === sourceSha,
        "the artifact source SHA does not match the checkout",
      );
      assert(
        metadata.tarball === `holycodex-${version}.tgz`,
        "the artifact tarball name does not match the release version",
      );
      assert(
        metadata.tarballSha256 === expectedSha256,
        "the artifact digest does not match the validated release output",
      );
      const tarballPath = join(output, metadata.tarball);
      yield* requireFileEffect(tarballPath, "the downloaded release tarball");
      yield* promiseEffect(() =>
        assertSafeArtifactFile(tarballPath, metadata.tarball, "the release tarball"),
      );
      const actualSha256 = yield* promiseEffect(() => sha256File(tarballPath));
      assert(actualSha256 === metadata.tarballSha256, "the release tarball digest is not stable");
      yield* promiseEffect(() => assertPackedEntries(tarballPath, metadata.entries));
      return metadata;
    }),
  );
}

/** Check whether the matching release artifact is already published on npm. */
export function checkNpmPublication(
  outputDirectory: string,
  version: string,
  channel: ReleaseChannel,
  sourceSha: string,
  expectedSha256: string,
): Promise<"absent" | "matching"> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const metadata = yield* promiseEffect(() =>
        verifyReleaseArtifact(outputDirectory, version, channel, sourceSha, expectedSha256),
      );
      const response = yield* promiseEffect(() =>
        fetch(`https://registry.npmjs.org/holycodex/${encodeURIComponent(version)}`),
      );
      if (response.status === 404) {
        return "absent";
      }
      if (!response.ok) {
        throw new Error(`npm registry lookup failed with HTTP ${response.status}.`);
      }
      const raw: unknown = yield* promiseEffect(() => response.json());
      const published = decode(RegistryMetadataSchema, raw, "the npm publication metadata");
      assert(
        published.version === version,
        "the existing npm version does not match the release version",
      );
      assert(
        published.release.channel === channel && published.release.sourceSha === sourceSha,
        "the existing npm version has a different channel or source SHA",
      );
      const tarballResponse = yield* promiseEffect(() => fetch(published.dist.tarball));
      if (!tarballResponse.ok) {
        throw new Error(
          `the existing npm tarball could not be downloaded: HTTP ${tarballResponse.status}`,
        );
      }
      const bytes = new Uint8Array(yield* promiseEffect(() => tarballResponse.arrayBuffer()));
      const actualSha256 = yield* sha256BytesEffect(bytes);
      assert(
        actualSha256 === metadata.tarballSha256,
        "the existing npm version has a different artifact identity",
      );
      return "matching";
    }),
  );
}

/** Check whether the matching release artifact is already published on GitHub. */
export function checkGitHubPublication(
  outputDirectory: string,
  version: string,
  channel: ReleaseChannel,
  sourceSha: string,
  expectedSha256: string,
  repository: string,
): Promise<"absent" | "matching"> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const metadata = yield* promiseEffect(() =>
        verifyReleaseArtifact(outputDirectory, version, channel, sourceSha, expectedSha256),
      );
      const tag = `v${version}`;
      const githubEnvironment = allowlistedEnvironment([
        ...DEFAULT_COMMAND_ENVIRONMENT_KEYS,
        "GH_TOKEN",
      ]);
      const viewed = yield* runCommandEffect(
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
        release.isPrerelease === (channel === "dev" || version.includes("-")),
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
      yield* withTemporaryDirectoryEffect("holycodex-release-verify", (directory) =>
        Effect.gen(function* () {
          yield* runCheckedEffect(
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
          const { sha256File } = yield* loadPackageVerificationEffect();
          assert(
            (yield* promiseEffect(() => sha256File(downloaded))) === metadata.tarballSha256,
            "the existing GitHub asset has a different artifact identity",
          );
        }),
      );
      return "matching";
    }),
  );
}

/** Write release notes into the release output directory after validation. */
export function writeReleaseNotes(outputDirectory: string, notesPath: string): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const metadata = yield* readArtifactMetadataEffect(resolve(outputDirectory));
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
      yield* promiseEffect(() =>
        writeFile(resolve(decode(ArtifactPathSchema, notesPath, "the release notes path")), notes, {
          encoding: "utf8",
          mode: 0o600,
        }),
      );
    }),
  );
}

function loadPackageVerificationEffect(): Effect.Effect<
  typeof import("./package-verification.ts"),
  unknown
> {
  return Effect.gen(function* () {
    yield* ensureCodexGenerated();
    return yield* promiseEffect(() => import("./package-verification.ts"));
  });
}

function readArtifactMetadataEffect(
  outputDirectory: string,
): Effect.Effect<ArtifactMetadata, unknown> {
  return Effect.tryPromise({
    try: () => readFile(join(outputDirectory, "release-metadata.json"), "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.map((text) => JSON.parse(text) as unknown),
    Effect.map((raw) => decode(ArtifactMetadataSchema, raw, "the release artifact metadata")),
  );
}

function parseReleaseMarker(body: string): typeof ReleaseMarkerSchema.Type {
  const match = body.match(/<!--\s*holycodex-release:\s*(\{[^\r\n]+\})\s*-->/u);
  if (match?.[1] === undefined) {
    throw new Error("the GitHub release is missing its HolyCodex identity marker");
  }
  const raw: unknown = JSON.parse(match[1]);
  return decode(ReleaseMarkerSchema, raw, "the GitHub release identity marker");
}

function sha256BytesEffect(bytes: Uint8Array): Effect.Effect<string, unknown> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", copy),
    catch: (error) => error,
  }).pipe(
    Effect.map((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
}

function requireFileEffect(path: string, label: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => readFile(path),
    catch: () => new Error(`${label} is missing: ${path}`),
  }).pipe(Effect.asVoid);
}

function promiseEffect<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

function decode<A>(schema: Schema.Decoder<A>, value: unknown, label: string): A {
  const parsed = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(parsed)) {
    throw new Error(`${label} is invalid: ${String(parsed.failure)}`);
  }
  return parsed.success;
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
  const program = Effect.tryPromise({
    try: async () => {
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
          (
            await Effect.runPromise(
              readArtifactMetadataEffect(resolve(argument(parsed, 1, "artifact directory"))),
            )
          ).tarballSha256,
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
    },
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(
          JSON.stringify({
            status: "failed",
            message: error instanceof Error ? error.message : "release packaging failed",
          }),
        );
        process.exitCode = 1;
      }),
    ),
  );
  await Effect.runPromise(program);
}
