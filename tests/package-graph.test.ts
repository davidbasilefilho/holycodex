// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const PackageScriptName = Schema.String.pipe(Schema.maxLength(256));
const PackageScriptCommand = Schema.String.pipe(Schema.maxLength(4096));
const PackageManifest = Schema.Struct({
  name: Schema.String,
  private: Schema.Boolean,
  type: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  devDependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  bin: Schema.optional(Schema.Struct({ holycodex: Schema.optional(Schema.String) })),
  exports: Schema.optional(Schema.Struct({ ".": Schema.optional(Schema.String) })),
  files: Schema.optional(Schema.Array(Schema.String)),
  repository: Schema.optional(Schema.Struct({ type: Schema.Literal("git"), url: Schema.String })),
  publishConfig: Schema.optional(Schema.Struct({ access: Schema.Literal("public") })),
  scripts: Schema.optional(Schema.Record({ key: PackageScriptName, value: PackageScriptCommand })),
});
type PackageManifest = typeof PackageManifest.Type;
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
    "@holycodex/git-bash",
    "@holycodex/lsp-core",
    "@holycodex/lsp-daemon",
    "@holycodex/workflow-host",
    "@holycodex/workflow-runtime",
    "@holycodex/plugin",
    "@holycodex/safe-filesystem",
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
        expect(manifest.repository?.url).toBe("https://github.com/davidbasilefilho/holycodex.git");
        expect(manifest.publishConfig?.access).toBe("public");
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
    const raw: unknown = JSON.parse(await readFile(`${workspaceRoot}/${relativePath}`, "utf8"));
    const parsed = Schema.decodeUnknownEither(PackageManifest, {
      onExcessProperty: "error",
    })(raw);

    if (Either.isLeft(parsed)) {
      throw new Error(`${relativePath}: ${String(parsed.left)}`);
    }

    manifests.set(packageName, parsed.right);
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
