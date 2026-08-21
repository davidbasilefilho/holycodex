// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalManifestPath = "packages/cli/package.json";
const VersionText = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const CliManifest = Schema.Struct({
  name: Schema.Literal("holycodex"),
  version: Schema.String.pipe(Schema.pattern(VersionText)),
});
type CliManifest = typeof CliManifest.Type;

describe("release version authority", () => {
  test("has exactly one canonical release-version literal in authored text", async () => {
    const manifest = await readCanonicalManifest();
    const occurrences: Array<Readonly<{ path: string; count: number }>> = [];
    for (const relativePath of await listFiles(workspaceRoot)) {
      const content = await readFile(`${workspaceRoot}/${relativePath}`, "utf8");
      const count = countLiteral(content, manifest.version);
      if (count > 0) {
        occurrences.push({ path: relativePath, count });
      }
    }

    expect(occurrences).toEqual([{ path: canonicalManifestPath, count: 1 }]);
  });

  test("keeps the canonical version in the public CLI manifest", async () => {
    const manifest = await readCanonicalManifest();

    expect(manifest.version).toMatch(VersionText);
  });
});

async function listFiles(directory: string, prefix = ""): Promise<readonly string[]> {
  const files: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isGeneratedOrPackageManagerPath(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(`${directory}/${entry.name}`, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

function isGeneratedOrPackageManagerPath(relativePath: string): boolean {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const generatedPrefixes = [
    ".git/",
    ".cache/",
    ".codex-test-home/",
    ".codex-test-state/",
    ".task-cache/",
    ".turbo/",
    ".vite-plus/",
    ".vite/",
    ".vp-cache/",
    ".vp/",
    "build/",
    "coverage/",
    "dist/",
    "generated/",
    "node_modules/",
    "out/",
    "payloads/",
    "scratch/",
    "temp/",
    "tmp/",
  ];

  return (
    normalizedPath === "bun.lock" ||
    normalizedPath === "bun.lockb" ||
    generatedPrefixes.some((prefix) => normalizedPath.startsWith(prefix))
  );
}

async function readCanonicalManifest(): Promise<CliManifest> {
  const raw: unknown = JSON.parse(
    await readFile(`${workspaceRoot}/${canonicalManifestPath}`, "utf8"),
  );
  const parsed = Schema.decodeUnknownEither(CliManifest)(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(String(parsed.left));
  }
  return parsed.right;
}

function countLiteral(content: string, literal: string): number {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...content.matchAll(new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`, "gu"))]
    .length;
}
