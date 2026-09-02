// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(workspaceRoot, "packages");

// These are the existing Promise-facing seams. New domain APIs must expose an
// Effect and add a deliberate leaf adapter instead of expanding this list.
const promiseAdapterAllowlist = new Set([
  "packages/cli/src/binary.ts",
  "packages/cli/src/commands.ts",
  "packages/cli/src/installer.ts",
  "packages/cli/src/maintenance.ts",
  "packages/cli/src/manifest.ts",
  "packages/cli/src/native-agents.ts",
  "packages/cli/src/paths.ts",
  "packages/cli/src/storage.ts",
  "packages/cli/src/types.ts",
  "packages/codex/src/client.ts",
  "packages/codex/src/executable.ts",
  "packages/codex/src/generated-artifact.ts",
  "packages/codex/src/official-plugins.ts",
  "packages/codex/src/transport.ts",
  "packages/core/src/canonical.ts",
  "packages/plugin/src/assembly.ts",
  "packages/plugin/src/planning.ts",
  "packages/plugin/src/schemas.ts",
  "packages/plugin/src/source.ts",
  "packages/plugin/src/verification.ts",
]);

const ioAdapterAllowlist = new Set([
  "packages/cli/src/binary.ts",
  "packages/cli/src/installer.ts",
  "packages/cli/src/lock.ts",
  "packages/cli/src/maintenance.ts",
  "packages/cli/src/manifest.ts",
  "packages/cli/src/migration.ts",
  "packages/cli/src/native-agents.ts",
  "packages/cli/src/official-manager.ts",
  "packages/cli/src/paths.ts",
  "packages/cli/src/storage.ts",
  "packages/cli/src/index.ts",
  "packages/codex/src/executable.ts",
  "packages/codex/src/generated-artifact.ts",
  "packages/codex/src/official-plugins.ts",
  "packages/codex/src/transport.ts",
  "packages/plugin/src/assembly.ts",
  "packages/plugin/src/source.ts",
]);

describe("Effect architecture boundaries", () => {
  test("keeps forbidden imports and unsafe any out of production source", async () => {
    const files = await sourceFiles(sourceRoot);
    const violations: string[] = [];
    for (const path of files) {
      const source = await readFile(path, "utf8");
      const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (/effect\/internal/u.test(source)) violations.push(`${relativePath}: effect/internal`);
      if (/(?:\bas\s+any\b|:\s*any\b|<any>|[|&]\s*any\b)/u.test(source)) {
        violations.push(`${relativePath}: any`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("requires Promise APIs and direct platform I/O to stay in explicit adapters", async () => {
    const files = await sourceFiles(sourceRoot);
    const violations: string[] = [];
    for (const path of files) {
      const source = await readFile(path, "utf8");
      const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (
        /export\s+(?:async\s+)?function[\s\S]*?Promise|export\s+interface[\s\S]*?Promise/u.test(
          source,
        )
      ) {
        if (!promiseAdapterAllowlist.has(relativePath))
          violations.push(`${relativePath}: Promise API`);
      }
      if (
        /from\s+["']node:(?:fs|fs\/promises|child_process|process|os|net|http|https)["']|\bprocess\./u.test(
          source,
        ) &&
        !ioAdapterAllowlist.has(relativePath)
      ) {
        violations.push(`${relativePath}: direct platform I/O`);
      }
    }
    expect(violations).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const portablePath = path.replaceAll("\\", "/");
    if (entry.isDirectory() && entry.name !== "scripts" && entry.name !== "dist")
      result.push(...(await sourceFiles(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !portablePath.includes("/generated/")
    )
      result.push(path);
  }
  return result;
}
