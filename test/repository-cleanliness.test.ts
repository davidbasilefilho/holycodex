import { access, readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const forbiddenNotesPath = [".agents", "NOTES.md"].join("/");
const ignoredDirectories = new Set([".git", "node_modules", ".tmp"]);

async function repositoryFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        files.push(...(await repositoryFiles(`${root}/${entry.name}`)));
      continue;
    }
    if (entry.isFile()) files.push(`${root}/${entry.name}`);
  }
  return files;
}

describe("repository cleanliness", () => {
  it("does not retain the forbidden notes file or direct references", async () => {
    await expect(access(forbiddenNotesPath)).rejects.toThrow();
    const files = await repositoryFiles(".");
    for (const path of files) {
      await expect(readFile(path, "utf8")).resolves.not.toContain(forbiddenNotesPath);
    }
  });
});
