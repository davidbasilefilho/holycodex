// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  assertReleaseVersion,
  developmentVersion,
  stableVersionFromTag,
} from "../scripts/release-version.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalManifestPath = "packages/cli/package.json";
const generatedPluginManifestPath = "packages/plugin/assets/.codex-plugin/plugin.json";
const VersionText = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RELEASE_LITERAL =
  /(?<![0-9A-Za-z])0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-dev\.\d+\.\d+)?(?![0-9A-Za-z])/gu;
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

    expect(occurrences).toEqual([
      { path: canonicalManifestPath, count: 1 },
      { path: generatedPluginManifestPath, count: 1 },
    ]);
  });

  test("keeps the canonical version in the public CLI manifest", async () => {
    const manifest = await readCanonicalManifest();

    expect(manifest.version).toMatch(VersionText);
  });

  test("keeps shared dependency versions in the root Bun catalog", async () => {
    const rootManifest = JSON.parse(await readFile(`${workspaceRoot}/package.json`, "utf8")) as {
      catalog?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    };
    const sharedDependencies = [
      "@jitl/quickjs-ffi-types",
      "@jitl/quickjs-wasmfile-debug-asyncify",
      "@jitl/quickjs-wasmfile-debug-sync",
      "@jitl/quickjs-wasmfile-release-asyncify",
      "@jitl/quickjs-wasmfile-release-sync",
      "@types/bun",
      "@types/node",
      "effect",
      "quickjs-emscripten",
      "quickjs-emscripten-core",
      "typescript",
      "vite-plus",
      "vitest",
    ] as const;
    const catalog = rootManifest.catalog ?? {};
    for (const dependency of sharedDependencies) {
      expect(catalog[dependency]).toBeTruthy();
      if (rootManifest.devDependencies?.[dependency] !== undefined) {
        expect(rootManifest.devDependencies[dependency]).toBe("catalog:");
      }
    }
    for (const relativePath of await listFiles(workspaceRoot)) {
      if (!/^packages\/[^/]+\/package\.json$/u.test(relativePath)) continue;
      const packageManifest = JSON.parse(
        await readFile(`${workspaceRoot}/${relativePath}`, "utf8"),
      ) as {
        dependencies?: Readonly<Record<string, string>>;
        devDependencies?: Readonly<Record<string, string>>;
      };
      for (const dependency of sharedDependencies) {
        const version =
          packageManifest.dependencies?.[dependency] ??
          packageManifest.devDependencies?.[dependency];
        if (version !== undefined) expect(version).toBe("catalog:");
      }
    }
  });

  test("rejects stale HolyCodex release literals outside owned version domains", async () => {
    const manifest = await readCanonicalManifest();
    const rootManifest = JSON.parse(await readFile(`${workspaceRoot}/package.json`, "utf8")) as {
      catalog?: Readonly<Record<string, string>>;
    };
    const dependencyVersions = new Set(Object.values(rootManifest.catalog ?? {}));
    const violations: string[] = [];
    for (const relativePath of await listFiles(workspaceRoot)) {
      if (relativePath === "tests/version-authority.test.ts") continue;
      const content = await readFile(`${workspaceRoot}/${relativePath}`, "utf8");
      for (const match of content.matchAll(RELEASE_LITERAL)) {
        const literal = match[0];
        if (
          (relativePath === canonicalManifestPath ||
            relativePath === generatedPluginManifestPath) &&
          literal === manifest.version
        )
          continue;
        if (isOwnedNonHolyCodexVersion(relativePath, literal, dependencyVersions)) continue;
        violations.push(`${relativePath}: ${literal}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("derives collision-safe development versions without changing the base version", () => {
    const version = developmentVersion("0.1.2", "17", "3");

    expect(version).toBe("0.1.2-dev.17.3");
    expect(version).not.toBe("0.1.2-dev.17.2");
    expect(() => developmentVersion("0.1.2", "0", "1")).toThrow();
  });

  test("requires stable tags to match the canonical version and rejects prerelease mixing", () => {
    expect(stableVersionFromTag("0.1.2", "v0.1.2")).toBe("0.1.2");
    expect(() => stableVersionFromTag("0.1.2", "v0.1.3")).toThrow();
    expect(() => assertReleaseVersion("0.1.2", "stable", "0.1.2-dev.17.3")).toThrow();
    expect(() => assertReleaseVersion("0.1.2", "dev", "0.1.2")).toThrow();
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
    ".tmp/",
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

  const segments = normalizedPath.split("/");
  return (
    normalizedPath === "bun.lock" ||
    normalizedPath === "bun.lockb" ||
    generatedPrefixes.some((prefix) => normalizedPath.startsWith(prefix)) ||
    segments.some((segment) => generatedPrefixes.includes(`${segment}/`))
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

function isOwnedNonHolyCodexVersion(
  relativePath: string,
  literal: string,
  dependencyVersions: ReadonlySet<string>,
): boolean {
  if (dependencyVersions.has(literal)) return true;
  if (literal === "0.148.0") {
    return (
      relativePath.includes("packages/codex/generated/") ||
      relativePath.includes("packages/codex/test/fixtures/") ||
      relativePath.startsWith("packages/codex/src/") ||
      [
        "docs/BEHAVIOR.md",
        "docs/DEPENDENCIES.md",
        "docs/PARITY.md",
        "docs/PROVENANCE.md",
        "docs/SECURITY.md",
        "scripts/repository-proof.ts",
        "THIRD-PARTY-NOTICES.md",
        "tests/parity.test.ts",
      ].includes(relativePath)
    );
  }
  if (literal === "0.1.0") {
    return ["packages/plugin/src/index.test.ts", "packages/cli/src/index.test.ts"].includes(
      relativePath,
    );
  }
  return false;
}
