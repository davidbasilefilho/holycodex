// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
describe("documentation invariants", () => {
  test("keeps every local Markdown link resolvable", async () => {
    const markdownFiles = [
      "AGENTS.md",
      "README.md",
      "THIRD-PARTY-NOTICES.md",
      ...(await listMarkdownFiles(resolve(workspaceRoot, "docs"), "docs")),
    ];

    for (const relativePath of markdownFiles) {
      const content = await readFile(resolve(workspaceRoot, relativePath), "utf8");
      for (const target of localTargets(content)) {
        const withoutFragment = target.split("#", 1)[0]?.split("?", 1)[0] ?? "";
        if (withoutFragment.length === 0) {
          continue;
        }
        const candidate = resolve(dirname(resolve(workspaceRoot, relativePath)), withoutFragment);
        expect(candidate.startsWith(`${workspaceRoot}${sep}`)).toBe(true);
        await expect(stat(candidate)).resolves.toBeDefined();
      }
    }
  });

  test("keeps documentation policy free of stale validators", async () => {
    const files = [
      "AGENTS.md",
      "README.md",
      "THIRD-PARTY-NOTICES.md",
      ...(await listMarkdownFiles(resolve(workspaceRoot, "docs"), "docs")),
    ];
    for (const relativePath of files) {
      const content = await readFile(resolve(workspaceRoot, relativePath), "utf8");
      expect(content).not.toMatch(/arktype/iu);
    }
    const behavior = await readFile(resolve(workspaceRoot, "docs/BEHAVIOR.md"), "utf8");
    const cli = await readFile(resolve(workspaceRoot, "docs/CLI.md"), "utf8");
    expect(behavior).toContain("native specialist roles");
    expect(behavior).toContain("native plugin");
    expect(cli).toContain("--frontend");
    expect(cli).toContain("capability_denied");
  });
});

async function listMarkdownFiles(directory: string, prefix = ""): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isGeneratedPath(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(resolve(directory, entry.name), relativePath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function localTargets(content: string): readonly string[] {
  const targets: string[] = [];
  const pattern = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  for (const match of content.matchAll(pattern)) {
    const target = match[1];
    if (
      target !== undefined &&
      !target.startsWith("#") &&
      !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)
    ) {
      targets.push(target);
    }
  }
  return targets;
}

function isGeneratedPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized === "bun.lock" ||
    /^(?:node_modules|dist|coverage|tmp|temp|generated)\//u.test(normalized)
  );
}
