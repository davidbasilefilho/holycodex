// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

describe("safe filesystem native source contract", () => {
  test("contains the handle-relative no-follow primitives and bounded protocol", async () => {
    const source = await readFile(
      join(dirname(import.meta.dirname), "native/safe_filesystem.c"),
      "utf8",
    );
    for (const marker of [
      "O_DIRECTORY",
      "O_NOFOLLOW",
      "openat",
      "mkdirat",
      "renameat",
      "unlinkat",
      "AT_SYMLINK_NOFOLLOW",
      "root_identity",
      "cleanup_staging_files",
      "FILE_FLAG_OPEN_REPARSE_POINT",
      "FILE_FLAG_BACKUP_SEMANTICS",
      "NtCreateFile",
      "RootDirectory",
      "FlushFileBuffers",
      "CREATE_NEW",
      "FILE_DISPOSITION_INFO_EX",
      "SAFE_MAX_LINE",
      "SAFE_MAX_FILE",
      "SAFE_MAX_DATA",
    ]) {
      expect(source).toContain(marker);
    }
  });

  test("rejects unsafe protocol target characters in the native source", async () => {
    const source = await readFile(
      join(dirname(import.meta.dirname), "native/safe_filesystem.c"),
      "utf8",
    );
    expect(source).toContain("safe_target");
    expect(source).toContain("safe_component");
    expect(source).toContain("link_reparse");
    expect(source).toContain("holycodex-stage-");
    expect(source).toContain("GetFinalPathNameByHandleW");
    expect(source).toContain("DuplicateHandle");
  });
});
