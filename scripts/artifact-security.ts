// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import * as Effect from "effect/Effect";

import { isSensitiveEnvironmentKey } from "./process.ts";

/**
 * Names that must never cross a package, build-upload, or release boundary. This is deliberately
 * broader than the VCS ignore list: an ignored local file can still be copied into a staged
 * directory by an unsafe build.
 */
const SENSITIVE_PATH_PART_PATTERN =
  /^(?:\.env(?:\..*)?|.*[._-]env(?:\..*)?|\.npmrc(?:\..*)?|\.pypirc(?:\..*)?|\.aws(?:\..*)?|\.ssh(?:\..*)?|\.kube(?:\..*)?|\.terraform(?:\..*)?|(?:auth|authorization|credential|credentials|secret|secrets|token|tokens)(?:\..*)?|.*\.tfstate(?:\..*)?|.*\.(?:auth|cert|cer|cookie|credential|credentials|der|jks|key|keystore|pem|pfx|p12|secret|secrets|token|tokens))$/iu;

/** Return whether an artifact path contains a secret-like component. */
export function isSensitiveArtifactPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").some((part) => SENSITIVE_PATH_PART_PATTERN.test(part));
}

/** Enforce path safety and an explicit allowlist for artifact entries. */
export function assertAllowedArtifactEntries(
  entries: readonly string[],
  allowlist: readonly (string | RegExp)[],
  label: string,
): void {
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      normalized.split("/").some((part) => part === ".." || part.length === 0)
    ) {
      throw new Error(`${label} contains an unsafe file path: ${entry}`);
    }
    if (isSensitiveArtifactPath(normalized)) {
      throw new Error(`${label} contains a sensitive file path: ${entry}`);
    }
    const allowed = allowlist.some((candidate) =>
      typeof candidate === "string" ? normalized === candidate : candidate.test(normalized),
    );
    if (!allowed) {
      throw new Error(`${label} contains an undeclared file: ${entry}`);
    }
  }
}

/**
 * Enumerate a staged tree while rejecting links and secret-like names. The returned paths are
 * relative, normalized with forward slashes, and stable.
 */
export function listSafeArtifactEntries(root: string, label: string): Promise<string[]> {
  return Effect.runPromise(Effect.suspend(() => listSafeArtifactEntriesEffect(root, label)));
}

function listSafeArtifactEntriesEffect(
  root: string,
  label: string,
): Effect.Effect<string[], unknown> {
  const resolvedRoot = resolve(root);
  const entries: string[] = [];
  const visit = (directory: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const children = yield* Effect.tryPromise({
        try: () => readdir(directory, { withFileTypes: true }),
        catch: (error) => error,
      });
      for (const entry of children) {
        const absolute = join(directory, entry.name);
        const relativePath = relative(resolvedRoot, absolute).split("\\").join("/");
        if (isSensitiveArtifactPath(relativePath)) {
          throw new Error(`${label} contains a sensitive file path: ${relativePath}`);
        }
        const metadata = yield* Effect.tryPromise({
          try: () => lstat(absolute),
          catch: (error) => error,
        });
        if (metadata.isSymbolicLink()) {
          throw new Error(`${label} may not contain symbolic links: ${relativePath}`);
        }
        if (metadata.isDirectory()) {
          yield* assertSafeArtifactDirectoryEffect(absolute, label);
          yield* visit(absolute);
        } else if (metadata.isFile()) {
          yield* assertSafeArtifactFileEffect(absolute, relativePath, label);
          entries.push(relativePath);
        } else {
          throw new Error(`${label} contains a non-file entry: ${relativePath}`);
        }
      }
    });
  return Effect.gen(function* () {
    yield* assertSafeArtifactDirectoryEffect(resolvedRoot, label);
    yield* visit(resolvedRoot);
    return entries.sort();
  });
}

/** Reject both secret-like filenames and values captured from this process. */
export function assertSafeArtifactFile(
  path: string,
  relativePath: string,
  label: string,
): Promise<void> {
  return Effect.runPromise(
    Effect.suspend(() => assertSafeArtifactFileEffect(path, relativePath, label)),
  );
}

function assertSafeArtifactFileEffect(
  path: string,
  relativePath: string,
  label: string,
): Effect.Effect<void, unknown> {
  if (isSensitiveArtifactPath(relativePath)) {
    throw new Error(`${label} contains a sensitive file path: ${relativePath}`);
  }
  return Effect.gen(function* () {
    yield* assertSafeArtifactPathEffect(path, label);
    const values = Object.entries(process.env)
      .filter(
        (entry): entry is [string, string] =>
          isSensitiveEnvironmentKey(entry[0]) && entry[1] !== undefined && entry[1].length > 0,
      )
      .map(([, value]) => value);
    if (values.length === 0) {
      return;
    }
    const bytes = yield* Effect.tryPromise({ try: () => readFile(path), catch: (error) => error });
    const content = new TextDecoder().decode(bytes);
    if (values.some((value) => content.includes(value))) {
      throw new Error(`${label} contains an environment secret value: ${relativePath}`);
    }
  });
}

function assertSafeArtifactPathEffect(path: string, label: string): Effect.Effect<void, unknown> {
  const absolute = resolve(path);
  return Effect.gen(function* () {
    let current = absolute;
    while (true) {
      const metadata = yield* Effect.tryPromise({
        try: () => lstat(current),
        catch: (error) => error,
      });
      if (metadata.isSymbolicLink()) {
        throw new Error(`${label} may not contain symbolic links.`);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  });
}

function assertSafeArtifactDirectoryEffect(
  path: string,
  label: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* assertSafeArtifactPathEffect(path, label);
    const metadata = yield* Effect.tryPromise({ try: () => lstat(path), catch: (error) => error });
    if (!metadata.isDirectory()) {
      throw new Error(`${label} root must be a regular directory.`);
    }
  });
}

/** Paths permitted in the packed public npm package. */
export const PUBLIC_PACKAGE_ENTRY_ALLOWLIST = [
  "package.json",
  "README.md",
  "dist/index.js",
  "dist/agent.js",
  "dist/assets/plugin/plugin.json",
  /^dist\/assets\/plugin\/skills\//u,
] as const;

/** Enforce the files allowed in the public package archive. */
export function assertPublicPackageEntries(entries: readonly string[]): void {
  assertAllowedArtifactEntries(entries, PUBLIC_PACKAGE_ENTRY_ALLOWLIST, "the public package");
}

/** Paths permitted in the CI build upload artifact. */
export const BUILD_UPLOAD_ENTRY_ALLOWLIST = [
  "index.js",
  "agent.js",
  "assets/plugin/plugin.json",
  /^assets\/plugin\/skills\//u,
] as const;

/** Enforce the files allowed in the build upload directory. */
export function assertBuildUploadEntries(entries: readonly string[]): void {
  assertAllowedArtifactEntries(entries, BUILD_UPLOAD_ENTRY_ALLOWLIST, "the build upload");
}

/** Validate the complete build upload directory against its allowlist. */
export function assertBuildUploadDirectory(root: string): Promise<void> {
  return Effect.runPromise(
    Effect.suspend(() =>
      listSafeArtifactEntriesEffect(root, "the build output").pipe(
        Effect.tap((entries) => Effect.sync(() => assertBuildUploadEntries(entries))),
        Effect.asVoid,
      ),
    ),
  );
}

/** Validate a release output directory and its expected tarball metadata. */
export function assertReleaseOutputDirectory(root: string, expectedTarball: string): Promise<void> {
  return Effect.runPromise(
    Effect.suspend(() => {
      if (!/^holycodex-[^/\\]+\.tgz$/u.test(expectedTarball)) {
        throw new Error("the expected release tarball name is invalid");
      }
      return listSafeArtifactEntriesEffect(root, "the release output").pipe(
        Effect.tap((entries) =>
          Effect.sync(() =>
            assertAllowedArtifactEntries(
              entries,
              ["release-metadata.json", expectedTarball],
              "the release output",
            ),
          ),
        ),
        Effect.tap((entries) =>
          Effect.sync(() => {
            if (!entries.includes(expectedTarball)) {
              throw new Error("the release output is missing its expected tarball");
            }
            if (!entries.includes("release-metadata.json")) {
              throw new Error("the release output is missing its identity metadata");
            }
          }),
        ),
        Effect.asVoid,
      );
    }),
  );
}
