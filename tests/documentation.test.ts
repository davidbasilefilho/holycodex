// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const owningTopics = {
  "README.md": ["package graph", "mise", "bun", "clean-room", "security"],
  "docs/INSTALLATION.md": [
    "content-addressed",
    "marketplace",
    "lock",
    "stage",
    "activate",
    "verify",
    "prune",
    "doctor",
    "cleanup",
    "a-to-b",
    "codex_home",
  ],
  "docs/STATE.md": [
    "schema epoch",
    "canonical identity",
    "journal",
    "checkpoint",
    "replay",
    "retained",
    "continuation",
    "refinement",
    "telemetry",
    "migration",
  ],
  "docs/CONFIGURATION.md": [
    "precedence",
    "plan",
    "tier",
    "optional",
    "explicit path",
    "compare-before-write",
    "secret",
  ],
  "docs/DEVELOPMENT.md": [
    "mise",
    "bun",
    "vite+",
    "typescript",
    "arktype",
    "dependency direction",
    "clean-room",
    "test isolation",
    "build",
  ],
  "docs/RELEASING.md": [
    "canonical version",
    "patch",
    "minor",
    "lockfile",
    "generated",
    "ci",
    "build",
    "pack",
    "install",
    "doctor",
    "provenance",
    "license",
    "commit",
    "push",
    "tag",
    "publication",
    "parentless",
  ],
  "docs/DEPENDENCIES.md": [
    "arktype",
    "quickjs",
    "vite-plus",
    "typescript",
    "bun",
    "license",
    "source",
  ],
  "THIRD-PARTY-NOTICES.md": ["arktype", "quickjs", "wasm", "development-only"],
} as const;

describe("documentation invariants", () => {
  test("keeps every local Markdown link resolvable", async () => {
    const markdownFiles = await listMarkdownFiles(workspaceRoot);

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

  test("keeps the owning documentation set and topics present", async () => {
    for (const [relativePath, topics] of Object.entries(owningTopics)) {
      const content = (await readFile(resolve(workspaceRoot, relativePath), "utf8")).toLowerCase();
      for (const topic of topics) {
        expect(content).toContain(topic);
      }
    }
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
