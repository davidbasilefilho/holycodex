import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceFileError } from "./errors";
import { editWorkspaceFile, readWorkspaceFile } from "./workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace file primitives", () => {
  it("reads a UTF-8 file through POSIX and Windows relative paths", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "note.txt"), "hello\n", "utf8");

    await expect(readWorkspaceFile({ root, filePath: "nested/note.txt" })).resolves.toEqual({
      path: "nested/note.txt",
      content: "hello\n",
    });
    await expect(readWorkspaceFile({ root, filePath: "nested\\note.txt" })).resolves.toEqual({
      path: "nested/note.txt",
      content: "hello\n",
    });
  });

  it("rejects traversal, missing paths, directories, and symlink escapes", async () => {
    const root = await createWorkspace();
    const outside = await createWorkspace();
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");
    await mkdir(join(root, "folder"));
    await symlink(outside, join(root, "escape"), "junction");

    await expect(readWorkspaceFile({ root, filePath: "../outside.txt" })).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    } satisfies Partial<WorkspaceFileError>);
    await expect(readWorkspaceFile({ root, filePath: "missing.txt" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(readWorkspaceFile({ root, filePath: "folder" })).rejects.toMatchObject({
      code: "NOT_A_FILE",
    });
    await expect(readWorkspaceFile({ root, filePath: "escape/outside.txt" })).rejects.toMatchObject(
      {
        code: "PATH_OUTSIDE_ROOT",
      },
    );
  });

  it("edits one exact match and rejects duplicate or absent content without writing", async () => {
    const root = await createWorkspace();
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "one\ntwo\n", "utf8");

    await expect(
      editWorkspaceFile({ root, filePath: "note.txt", oldString: "two", newString: "three" }),
    ).resolves.toMatchObject({
      path: "note.txt",
      content: "one\nthree\n",
    });
    await writeFile(filePath, "repeat repeat", "utf8");
    await expect(
      editWorkspaceFile({ root, filePath: "note.txt", oldString: "repeat", newString: "done" }),
    ).rejects.toMatchObject({
      code: "DUPLICATE_MATCH",
    });
    expect(await readFile(filePath, "utf8")).toBe("repeat repeat");
    await expect(
      editWorkspaceFile({ root, filePath: "note.txt", oldString: "missing", newString: "done" }),
    ).rejects.toMatchObject({
      code: "EXACT_MATCH_NOT_FOUND",
    });
    expect(await readFile(filePath, "utf8")).toBe("repeat repeat");
  });

  it("edits 1-based inclusive ranges and preserves LF, CRLF, and final newlines", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "lf.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");

    await expect(
      editWorkspaceFile({ root, filePath: "lf.txt", oldString: "2-3", newString: "two and three" }),
    ).resolves.toMatchObject({
      content: "one\ntwo and three\n",
    });
    await expect(
      editWorkspaceFile({ root, filePath: "crlf.txt", oldString: " 2 - 2 ", newString: "second" }),
    ).resolves.toMatchObject({
      content: "one\r\nsecond\r\nthree\r\n",
    });
  });

  it("treats range-shaped oldString values as ranges before exact content", async () => {
    const root = await createWorkspace();
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "first 2\nsecond\nthird\n", "utf8");

    await expect(
      editWorkspaceFile({ root, filePath: "note.txt", oldString: "2", newString: "replacement" }),
    ).resolves.toMatchObject({ content: "first 2\nreplacement\nthird\n" });
  });

  it("does not add blank lines when range replacements end in target line endings", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "lf.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");

    await expect(
      editWorkspaceFile({ root, filePath: "lf.txt", oldString: "2", newString: "two\n" }),
    ).resolves.toMatchObject({ content: "one\ntwo\nthree\n" });
    await expect(
      editWorkspaceFile({ root, filePath: "crlf.txt", oldString: "2", newString: "two\r\n" }),
    ).resolves.toMatchObject({ content: "one\r\ntwo\r\nthree\r\n" });
  });

  it("rejects overlapping matches and deletes selected lines without blank lines", async () => {
    const root = await createWorkspace();
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "aaa", "utf8");

    await expect(
      editWorkspaceFile({ root, filePath: "note.txt", oldString: "aa", newString: "done" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_MATCH" });
    expect(await readFile(filePath, "utf8")).toBe("aaa");

    await writeFile(filePath, "one\ntwo\nthree\n", "utf8");
    await expect(
      editWorkspaceFile({ root, filePath: "note.txt", oldString: "2", newString: "" }),
    ).resolves.toMatchObject({ content: "one\nthree\n" });
    await expect(
      editWorkspaceFile({ root, filePath: "note.txt", oldString: "1-2", newString: "" }),
    ).resolves.toMatchObject({ content: "" });
  });

  it("preserves the target file mode during atomic replacement", async () => {
    const root = await createWorkspace();
    const filePath = join(root, "mode.txt");
    await writeFile(filePath, "before", "utf8");
    const originalMode = (await stat(filePath)).mode & 0o7777;

    await editWorkspaceFile({
      root,
      filePath: "mode.txt",
      oldString: "before",
      newString: "after",
    });

    expect((await stat(filePath)).mode & 0o7777).toBe(originalMode);
  });

  it("rejects invalid, reversed, and out-of-range ranges without writing", async () => {
    const root = await createWorkspace();
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "one\ntwo\n", "utf8");

    for (const oldString of ["0", "3", "2-1", "line 2"]) {
      await expect(
        editWorkspaceFile({ root, filePath: "note.txt", oldString, newString: "done" }),
      ).rejects.toBeInstanceOf(WorkspaceFileError);
      expect(await readFile(filePath, "utf8")).toBe("one\ntwo\n");
    }
  });
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexslimedit-"));
  temporaryDirectories.push(directory);
  return directory;
}
