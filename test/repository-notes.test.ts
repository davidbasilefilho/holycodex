import { access, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

const excludedDirectories = new Set([
  ".git",
  ".tmp",
  "build",
  "cache",
  "coverage",
  "dist",
  "node_modules",
]);
const obsoleteNotesPath = [".agents", "NOTES.md"].join("/");

describe("repository notes contract", () => {
  it("contains neither the obsolete notes file nor instructions that reference it", async () => {
    await expect(access(obsoleteNotesPath)).rejects.toMatchObject({ code: "ENOENT" });
    const violations: string[] = [];
    for (const path of await repositoryFiles(".")) {
      const content = await readFile(path);
      if (content.includes(0)) continue;
      const source = content.toString("utf8");
      if (source.includes(obsoleteNotesPath.replaceAll("/", "\\"))) violations.push(path);
      if (source.includes(obsoleteNotesPath)) violations.push(path);
      if (
        basename(path) === "AGENTS.md" &&
        new RegExp(["durable", "(?:implementation\\s+)?notes"].join("\\s+"), "i").test(source)
      )
        violations.push(path);
    }
    expect([...new Set(violations)]).toEqual([]);
  });
});

async function repositoryFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await repositoryFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
