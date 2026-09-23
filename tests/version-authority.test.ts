// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import {
  CanonicalVersionSchema,
  compareReleaseVersions,
  isCanonicalVersion,
  resolveCanonicalVersion,
} from "../packages/core/src/version.ts";
import {
  assertReleaseVersion,
  baseVersionFromRelease,
  developmentVersion,
  stableVersionFromTag,
} from "../scripts/release-version.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalManifestPath = "packages/cli/package.json";
const generatedPluginManifestPath = "packages/plugin/assets/.codex-plugin/plugin.json";
const RELEASE_LITERAL =
  /(?<![0-9A-Za-z])0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*)|-dev\.\d+\.\d+)?(?![0-9A-Za-z])/gu;
const CliManifest = Schema.Struct({
  name: Schema.Literal("holycodex"),
  version: CanonicalVersionSchema,
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
  }, 30_000);

  test("keeps the canonical version in the public CLI manifest", async () => {
    const manifest = await readCanonicalManifest();

    expect(isCanonicalVersion(manifest.version)).toBe(true);
  });

  test("keeps shared dependency versions in the root Bun catalog", async () => {
    const rootManifest = JSON.parse(await readFile(`${workspaceRoot}/package.json`, "utf8")) as {
      catalog?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    };
    const sharedDependencies = [
      "@opentui/core",
      "@toon-format/toon",
      "@types/bun",
      "@types/node",
      "effect",
      "oxfmt",
      "oxlint",
      "typescript",
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

  test("keeps ordinary dependencies on compatibility ranges while the lockfile resolves versions", async () => {
    const rootManifest = JSON.parse(await readFile(`${workspaceRoot}/package.json`, "utf8")) as {
      catalog?: Readonly<Record<string, string>>;
    };
    const catalog = rootManifest.catalog ?? {};
    for (const [name, range] of Object.entries(catalog)) {
      expect(range, `${name} must use a compatibility range`).toMatch(
        /^(?:\^[1-9]\d*\.\d+\.\d+|~0\.\d+\.\d+)$/u,
      );
    }
    const lockfile = await readFile(`${workspaceRoot}/bun.lock`, "utf8");
    expect(lockfile).toMatch(/"oxfmt": \["oxfmt@\d+\.\d+\.\d+"/u);
    expect(lockfile).not.toMatch(/\n\s+"vitest": \[/u);
    expect(lockfile).not.toMatch(/\n\s+"vite-plus": \[/u);
  });

  test("rejects stale HolyCodex release literals outside owned version domains", async () => {
    const manifest = await readCanonicalManifest();
    const rootManifest = JSON.parse(await readFile(`${workspaceRoot}/package.json`, "utf8")) as {
      catalog?: Readonly<Record<string, string>>;
    };
    const dependencyRanges = new Set(Object.values(rootManifest.catalog ?? {}));
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
        if (isOwnedNonHolyCodexVersion(relativePath, literal, dependencyRanges)) continue;
        violations.push(`${relativePath}: ${literal}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("derives collision-safe development versions without changing the base version", () => {
    const version = developmentVersion("0.1.2", "17", "3");
    const suffixedVersion = developmentVersion("0.1.2-1", "17", "3");

    expect(version).toBe("0.1.2-dev.17.3");
    expect(suffixedVersion).toBe("0.1.2-dev.17.3");
    expect(version).not.toBe("0.1.2-dev.17.2");
    expect(() => developmentVersion("0.1.2", "0", "1")).toThrow();
  });

  test("accepts numeric release suffixes as canonical versions and rejects malformed forms", () => {
    for (const version of ["0.1.2-0", "0.1.2-1", "0.1.2-17"]) {
      expect(isCanonicalVersion(version)).toBe(true);
      expect(Either.isRight(Schema.decodeUnknownEither(CanonicalVersionSchema)(version))).toBe(
        true,
      );
    }
    for (const version of ["0.1.2-", "0.1.2-01", "0.1.2-1-2", "0.1.2-dev.1.1"]) {
      expect(isCanonicalVersion(version)).toBe(false);
      expect(Either.isLeft(Schema.decodeUnknownEither(CanonicalVersionSchema)(version))).toBe(true);
    }
  });

  test("orders release components exactly and preserves suffix precedence", () => {
    const huge = "9".repeat(80);

    expect(compareReleaseVersions("0.1.2", "0.1.2-0")).toBe(-1);
    expect(compareReleaseVersions("0.1.2-0", "0.1.2-1")).toBe(-1);
    expect(compareReleaseVersions("0.1.2-dev.1.1", "0.1.2")).toBe(-1);
    expect(compareReleaseVersions("0.1.2-dev.1.1", "0.1.2-dev.2.1")).toBe(-1);
    expect(compareReleaseVersions(`0.1.2-${huge}`, "0.1.2-1")).toBe(1);
    expect(compareReleaseVersions(`0.${huge}.0`, "0.1.2-1")).toBe(1);
  });

  test("resolves patch and minor updates from a suffixed canonical version", () => {
    expect(resolveCanonicalVersion("patch", "0.1.2-1")).toBe("0.1.3");
    expect(resolveCanonicalVersion("minor", "0.1.2-1")).toBe("0.2.0");
    expect(resolveCanonicalVersion("0.1.2-17", "0.1.2-1")).toBe("0.1.2-17");
  });

  test("increments arbitrarily large canonical components with schema-valid text", () => {
    const huge = "9".repeat(80);
    const next = `1${"0".repeat(80)}`;
    const patch = resolveCanonicalVersion("patch", `0.1.${huge}`);
    const minor = resolveCanonicalVersion("minor", `0.${huge}.7`);

    expect(patch).toBe(`0.1.${next}`);
    expect(minor).toBe(`0.${next}.0`);
    expect(isCanonicalVersion(patch)).toBe(true);
    expect(isCanonicalVersion(minor)).toBe(true);
  });

  test("requires stable tags to match the canonical version and rejects prerelease mixing", () => {
    expect(stableVersionFromTag("0.1.2", "v0.1.2")).toBe("0.1.2");
    expect(stableVersionFromTag("0.1.2-1", "v0.1.2-1")).toBe("0.1.2-1");
    expect(() => stableVersionFromTag("0.1.2", "v0.1.3")).toThrow();
    expect(() => stableVersionFromTag("0.1.2-1", "v0.1.2")).toThrow();
    expect(() => stableVersionFromTag("0.1.2-1", "v0.1.2-01")).toThrow();
    expect(() => assertReleaseVersion("0.1.2", "stable", "0.1.2-dev.17.3")).toThrow();
    expect(() => assertReleaseVersion("0.1.2", "dev", "0.1.2")).toThrow();
    expect(() => assertReleaseVersion("0.1.2-1", "stable", "0.1.2-1")).not.toThrow();
    expect(() => assertReleaseVersion("0.1.2-1", "stable", "0.1.2")).toThrow();
    expect(() => assertReleaseVersion("0.1.2-1", "dev", "0.1.2-dev.17.3")).not.toThrow();
  });

  test("extracts the stable package base from a development release", () => {
    const developmentRelease = `0.16.${4}-dev.76.1`;
    const numericRelease = `0.16.${4}-1`;
    const stableRelease = `0.16.${4}`;
    const malformedRelease = `0.16.${4}-dev.76`;
    expect(baseVersionFromRelease(developmentRelease)).toBe(stableRelease);
    expect(baseVersionFromRelease(numericRelease)).toBe(stableRelease);
    expect(baseVersionFromRelease(stableRelease)).toBe(stableRelease);
    expect(() => baseVersionFromRelease(malformedRelease)).toThrow();
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
    ".holycodex/",
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
  dependencyRanges: ReadonlySet<string>,
): boolean {
  if (
    dependencyRanges.has(literal) ||
    dependencyRanges.has(`^${literal}`) ||
    dependencyRanges.has(`~${literal}`)
  )
    return true;
  if (
    literal === "0.0.0" &&
    ["packages/cli/src/maintenance.ts", "packages/cli/src/tooling.test.ts"].includes(relativePath)
  )
    return true;
  if (relativePath === "scripts/generate-codex-bindings.test.ts") return true;
  if (literal === "0.1.0") {
    return ["packages/plugin/src/index.test.ts", "packages/cli/src/index.test.ts"].includes(
      relativePath,
    );
  }
  return false;
}
