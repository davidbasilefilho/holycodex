// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const owningTopics = {
  "README.md": [
    "package graph",
    "mise",
    "bun",
    "clean-room",
    "security",
    "native",
    "optional capability",
    "agent types",
  ],
  "docs/INSTALLATION.md": [
    "native plugin",
    "plugin installation",
    "owned installation",
    "remove",
    "configuration",
  ],
  "docs/STATE.md": ["schema epoch", "canonical", "digest", "install identity", "removal"],
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
    "effect schema",
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
    "provenance",
    "license",
    "commit",
    "push",
    "tag",
    "publication",
    "branch",
  ],
  "docs/DEPENDENCIES.md": [
    "effect",
    "effect schema",
    "boundary-validation",
    "vite-plus",
    "typescript",
    "bun",
    "license",
    "source",
  ],
  "docs/PARITY.md": [
    "clean-room base",
    "frozen behavioral oracle",
    "required surface inventory",
    "independent proof",
  ],
  "docs/DECISIONS.md": ["Effect Schema", "sole", "toolchain", "provenance", "approval-gated"],
  "docs/CUTOVER.md": [
    "preflight",
    "authority",
    "branch protection",
    "issue",
    "pull request",
    "release",
    "license",
    "provenance",
    "frozen",
    "holycodex-legacy",
    "holycodex-next",
    "fresh clone",
    "rollback",
    "babysit-ci",
  ],
  "THIRD-PARTY-NOTICES.md": ["generated codex", "development components", "vendored plugin skills"],
} as const;

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

  test("keeps the owning documentation set and topics present", async () => {
    for (const [relativePath, topics] of Object.entries(owningTopics)) {
      const content = (await readFile(resolve(workspaceRoot, relativePath), "utf8")).toLowerCase();
      for (const topic of topics) {
        expect(content).toContain(topic.toLowerCase());
      }
    }
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
