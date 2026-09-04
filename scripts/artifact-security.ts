// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { isSensitiveEnvironmentKey } from "./process.ts";

/**
 * Names that must never cross a package, build-upload, or release boundary. This is deliberately
 * broader than the VCS ignore list: an ignored local file can still be copied into a staged
 * directory by an unsafe build.
 */
const SENSITIVE_PATH_PART_PATTERN =
  /^(?:\.env(?:\..*)?|.*[._-]env(?:\..*)?|\.npmrc(?:\..*)?|\.pypirc(?:\..*)?|\.aws(?:\..*)?|\.ssh(?:\..*)?|\.kube(?:\..*)?|\.terraform(?:\..*)?|(?:auth|authorization|credential|credentials|secret|secrets|token|tokens)(?:\..*)?|.*\.tfstate(?:\..*)?|.*\.(?:auth|cert|cer|cookie|credential|credentials|der|jks|key|keystore|pem|pfx|p12|secret|secrets|token|tokens))$/iu;

export function isSensitiveArtifactPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").some((part) => SENSITIVE_PATH_PART_PATTERN.test(part));
}

export function assertAllowedArtifactEntries(
  entries: readonly string[],
  allowlist: readonly (string | RegExp)[],
  label: string,
): void {
  for (const entry of entries) {
    if (isSensitiveArtifactPath(entry)) {
      throw new Error(`${label} contains a sensitive file path: ${entry}`);
    }
    const allowed = allowlist.some((candidate) =>
      typeof candidate === "string" ? entry === candidate : candidate.test(entry),
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
export async function listSafeArtifactEntries(root: string, label: string): Promise<string[]> {
  const resolvedRoot = resolve(root);
  await assertSafeArtifactDirectory(resolvedRoot, label);
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(resolvedRoot, absolute).split("\\").join("/");
      if (isSensitiveArtifactPath(relativePath)) {
        throw new Error(`${label} contains a sensitive file path: ${relativePath}`);
      }
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`${label} may not contain symbolic links: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        await assertSafeArtifactDirectory(absolute, label);
        await visit(absolute);
      } else if (metadata.isFile()) {
        await assertSafeArtifactFile(absolute, relativePath, label);
        entries.push(relativePath);
      } else {
        throw new Error(`${label} contains a non-file entry: ${relativePath}`);
      }
    }
  };
  await visit(resolvedRoot);
  return entries.sort();
}

/** Reject both secret-like filenames and values captured from this process. */
export async function assertSafeArtifactFile(
  path: string,
  relativePath: string,
  label: string,
): Promise<void> {
  if (isSensitiveArtifactPath(relativePath)) {
    throw new Error(`${label} contains a sensitive file path: ${relativePath}`);
  }
  await assertSafeArtifactPath(path, label);
  const values = Object.entries(process.env)
    .filter(
      (entry): entry is [string, string] =>
        isSensitiveEnvironmentKey(entry[0]) && entry[1] !== undefined && entry[1].length > 0,
    )
    .map(([, value]) => value);
  if (values.length === 0) {
    return;
  }
  const content = new TextDecoder().decode(await readFile(path));
  if (values.some((value) => content.includes(value))) {
    throw new Error(`${label} contains an environment secret value: ${relativePath}`);
  }
}

async function assertSafeArtifactPath(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} may not contain symbolic links.`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function assertSafeArtifactDirectory(path: string, label: string): Promise<void> {
  await assertSafeArtifactPath(path, label);
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new Error(`${label} root must be a regular directory.`);
  }
}

export const PUBLIC_PACKAGE_ENTRY_ALLOWLIST = [
  "package.json",
  "README.md",
  "dist/index.js",
  "dist/assets/plugin/plugin.json",
  /^dist\/assets\/plugin\/skills\//u,
] as const;

export function assertPublicPackageEntries(entries: readonly string[]): void {
  assertAllowedArtifactEntries(entries, PUBLIC_PACKAGE_ENTRY_ALLOWLIST, "the public package");
}

export const BUILD_UPLOAD_ENTRY_ALLOWLIST = [
  "index.js",
  "assets/plugin/plugin.json",
  /^assets\/plugin\/skills\//u,
] as const;

export function assertBuildUploadEntries(entries: readonly string[]): void {
  assertAllowedArtifactEntries(entries, BUILD_UPLOAD_ENTRY_ALLOWLIST, "the build upload");
}

export async function assertBuildUploadDirectory(root: string): Promise<void> {
  const entries = await listSafeArtifactEntries(root, "the build output");
  assertBuildUploadEntries(entries);
}

export async function assertReleaseOutputDirectory(
  root: string,
  expectedTarball: string,
): Promise<void> {
  if (!/^holycodex-[^/\\]+\.tgz$/u.test(expectedTarball)) {
    throw new Error("the expected release tarball name is invalid");
  }
  const entries = await listSafeArtifactEntries(root, "the release output");
  assertAllowedArtifactEntries(
    entries,
    ["release-metadata.json", expectedTarball],
    "the release output",
  );
  if (!entries.includes(expectedTarball)) {
    throw new Error("the release output is missing its expected tarball");
  }
  if (!entries.includes("release-metadata.json")) {
    throw new Error("the release output is missing its identity metadata");
  }
}
