import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyWorkspacePatch } from "./patch";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace patch envelopes", () => {
  it("creates nested files and applies ordered update hunks", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "note.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");

    await expect(
      applyWorkspacePatch({
        root,
        patch:
          "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: note.txt\n@@\n-one\n+first\n@@\n-three\n+third\n*** End Patch",
      }),
    ).resolves.toEqual({ paths: ["nested/new.txt", "note.txt"] });
    await expect(readFile(join(root, "nested", "new.txt"), "utf8")).resolves.toBe("created\n");
    await expect(readFile(join(root, "note.txt"), "utf8")).resolves.toBe(
      "first\r\ntwo\r\nthird\r\n",
    );
  });

  it("rejects malformed, ambiguous, existing, traversal, and symlink-escape patches", async () => {
    const root = await createWorkspace();
    const outside = await createWorkspace();
    await writeFile(join(root, "note.txt"), "repeat\nrepeat\n", "utf8");
    await symlink(outside, join(root, "escape"), "junction");

    for (const [patch, code] of [
      ["*** Add File: note.txt\n+overwrite", "INVALID_PATCH"],
      ["*** Begin Patch\n*** Add File: note.txt\n+overwrite\n*** End Patch", "ALREADY_EXISTS"],
      [
        "*** Begin Patch\n*** Add File: ../outside.txt\n+escape\n*** End Patch",
        "PATH_OUTSIDE_ROOT",
      ],
      [
        "*** Begin Patch\n*** Add File: escape/outside.txt\n+escape\n*** End Patch",
        "PATH_OUTSIDE_ROOT",
      ],
      [
        "*** Begin Patch\n*** Update File: note.txt\n@@\n-repeat\n+changed\n*** End Patch",
        "DUPLICATE_MATCH",
      ],
    ] as const) {
      await expect(applyWorkspacePatch({ root, patch })).rejects.toMatchObject({ code });
    }
    await expect(readFile(join(root, "note.txt"), "utf8")).resolves.toBe("repeat\nrepeat\n");
  });
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexslimedit-patch-"));
  temporaryDirectories.push(directory);
  return directory;
}
