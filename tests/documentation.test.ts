// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(behavior).toContain("Explorer.lookup");
    expect(behavior).toContain('agents."<Role.task>"');
    expect(behavior).toContain("native plugin");
    expect(cli).toContain("--frontend");
    expect(cli).toContain("capability_denied");
  });

  test("keeps the product profile migration and Astra routing explicit", async () => {
    const [readme, cliReadme, cli, behavior, configuration, installation] = await Promise.all([
      readFile(resolve(workspaceRoot, "README.md"), "utf8"),
      readFile(resolve(workspaceRoot, "packages/cli/README.md"), "utf8"),
      readFile(resolve(workspaceRoot, "docs/CLI.md"), "utf8"),
      readFile(resolve(workspaceRoot, "docs/BEHAVIOR.md"), "utf8"),
      readFile(resolve(workspaceRoot, "docs/CONFIGURATION.md"), "utf8"),
      readFile(resolve(workspaceRoot, "docs/INSTALLATION.md"), "utf8"),
    ]);
    for (const content of [readme, cliReadme, behavior, configuration, installation]) {
      expect(content).toContain("gpt-6-astra");
      expect(content).toContain("gpt-5.6-luna");
      expect(content).not.toContain("The live plans are");
    }
    expect(readme).toContain("--profile <low|default|high>");
    expect(cliReadme).toContain("--profile");
    expect(cli).toContain("--profile <name>");
    expect(cli).not.toContain("--plan <name>");
    expect(behavior).toMatch(/The live profiles are\s+`low`, `default`, and `high`/u);
    expect(behavior).toContain("installation profile approval");
    expect(behavior).toContain("features.context_management.experimental_mode");
    expect(configuration).toContain(
      "does not manage `features.context_management.experimental_mode`",
    );
    expect(configuration).toMatch(/installation\s+profile approval/u);
    expect(installation).toContain("Legacy `go`");
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
