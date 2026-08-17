// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const PackageManifest = type({
  name: "string",
  private: "boolean",
  "version?": "string",
  "dependencies?": "object",
  "devDependencies?": "object",
  "bin?": type({ "holycodex?": "string" }),
  "exports?": type({ ".?": "string" }),
  "files?": "string[]",
});
type PackageManifest = typeof PackageManifest.infer;
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePaths = {
  "@holycodex/core": "packages/core/package.json",
  "@holycodex/codex": "packages/codex/package.json",
  "@holycodex/workflow-runtime": "packages/workflow-runtime/package.json",
  "@holycodex/workflow-host": "packages/workflow-host/package.json",
  "@holycodex/plugin": "packages/plugin/package.json",
  holycodex: "packages/cli/package.json",
} as const;

const expectedDependencies: Record<string, readonly string[]> = {
  "@holycodex/core": [],
  "@holycodex/codex": ["@holycodex/core"],
  "@holycodex/workflow-runtime": ["@holycodex/core"],
  "@holycodex/workflow-host": [
    "@holycodex/core",
    "@holycodex/codex",
    "@holycodex/workflow-runtime",
  ],
  "@holycodex/plugin": ["@holycodex/core"],
  holycodex: [
    "@holycodex/core",
    "@holycodex/codex",
    "@holycodex/workflow-host",
    "@holycodex/workflow-runtime",
    "@holycodex/plugin",
  ],
};

describe("workspace package graph", () => {
  test("keeps internal packages private and versionless", async () => {
    const manifests = await readManifests();

    for (const packageName of Object.keys(packagePaths)) {
      const manifest = manifests.get(packageName);
      expect(manifest).toBeDefined();

      if (!manifest) {
        continue;
      }

      if (packageName === "holycodex") {
        expect(manifest.private).toBe(false);
        expect(manifest.version).toMatch(/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
        expect(Object.values(manifest.dependencies ?? {})).not.toContain("workspace:*");
        expect(manifest.bin?.holycodex).toBe("./dist/index.js");
        expect(manifest.exports?.["."]).toBe("./dist/index.js");
        expect(manifest.files).toContain("dist");
      } else {
        expect(manifest.private).toBe(true);
        expect(manifest.version).toBeUndefined();
      }
    }
  });

  test("declares the intended acyclic workspace direction", async () => {
    const manifests = await readManifests();
    const graph = new Map<string, readonly string[]>();

    for (const [packageName, dependencies] of Object.entries(expectedDependencies)) {
      const manifest = manifests.get(packageName);
      expect(manifest).toBeDefined();

      if (!manifest) {
        continue;
      }

      const declaredDependencies = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })
        .filter((dependency) => dependency.startsWith("@holycodex/"))
        .sort();
      expect(declaredDependencies).toEqual([...dependencies].sort());
      graph.set(packageName, declaredDependencies);
    }

    expect(findCycle(graph)).toBeUndefined();
  });
});

async function readManifests(): Promise<Map<string, PackageManifest>> {
  const manifests = new Map<string, PackageManifest>();

  for (const [packageName, relativePath] of Object.entries(packagePaths)) {
    const parsed = PackageManifest(
      JSON.parse(await readFile(`${workspaceRoot}/${relativePath}`, "utf8")),
    );

    if (parsed instanceof type.errors) {
      throw new Error(`${relativePath}: ${parsed.summary}`);
    }

    manifests.set(packageName, parsed);
  }

  return manifests;
}

function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (packageName: string, path: string[]): string[] | undefined => {
    if (visiting.has(packageName)) {
      return [...path, packageName];
    }
    if (visited.has(packageName)) {
      return undefined;
    }

    visiting.add(packageName);
    for (const dependency of graph.get(packageName) ?? []) {
      const cycle = visit(dependency, [...path, packageName]);
      if (cycle) {
        return cycle;
      }
    }
    visiting.delete(packageName);
    visited.add(packageName);
    return undefined;
  };

  for (const packageName of graph.keys()) {
    const cycle = visit(packageName, []);
    if (cycle) {
      return cycle;
    }
  }

  return undefined;
}
