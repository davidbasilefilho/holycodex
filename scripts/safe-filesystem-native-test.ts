// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createSafeWorkflowFilesystemBoundary,
  SafeFilesystemError,
} from "../packages/safe-filesystem/src/index.ts";

export async function runSafeFilesystemNativeTest(helperPath: string): Promise<void> {
  const platform = process.platform === "win32" ? "win32" : "posix";
  const temporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, "holycodex-safe-filesystem-test-"));
  const ownedRoot = join(root, "owned");
  try {
    const boundary = createSafeWorkflowFilesystemBoundary({ platform, helperPath });
    await boundary.ensureDirectory(ownedRoot, ownedRoot);
    await Promise.all([
      boundary.ensureDirectory(ownedRoot, join(ownedRoot, "session")),
      boundary.ensureDirectory(ownedRoot, join(ownedRoot, "session")),
    ]);
    const sourcePath = join(ownedRoot, "session", "workflow.ts");
    const bytes = new TextEncoder().encode("export default 1;\n");
    await boundary.writeAtomicFile(ownedRoot, sourcePath, bytes);
    const read = await boundary.readOwnedFile(ownedRoot, sourcePath);
    if (new TextDecoder().decode(read) !== "export default 1;\n")
      throw new Error("native readback mismatch");
    const entries = await boundary.readDirectory(ownedRoot, join(ownedRoot, "session"));
    if (!entries.some((entry) => entry.name === "workflow.ts" && entry.kind === "file")) {
      throw new Error("native directory enumeration missed the written file");
    }
    const outside = await mkdtemp(join(temporaryRoot, "holycodex-safe-filesystem-outside-"));
    try {
      await symlink(
        outside,
        join(ownedRoot, "session", "link"),
        platform === "win32" ? "junction" : undefined,
      );
      const linkedEntries = await boundary.readDirectory(ownedRoot, join(ownedRoot, "session"));
      if (!linkedEntries.some((entry) => entry.name === "link" && entry.kind === "symlink")) {
        throw new Error("native directory enumeration did not expose the link as unsafe");
      }
      await boundary.removeOwnedDirectory(ownedRoot, join(ownedRoot, "session")).then(
        () => {
          throw new Error("native exact cleanup followed or accepted a link");
        },
        (error: unknown) => {
          if (!(error instanceof SafeFilesystemError)) throw error;
        },
      );
      await rm(join(ownedRoot, "session", "link"), { force: true });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    await boundary.removeOwnedDirectory(ownedRoot, join(ownedRoot, "session"));
  } catch (error: unknown) {
    if (error instanceof SafeFilesystemError) {
      throw new Error(`native ${error.operation} failed: ${error.message}`, { cause: error });
    }
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const platform = process.platform === "win32" ? "win32" : "posix";
    const helperRoot = resolve(import.meta.dirname, "../packages/cli/dist/assets/safe-filesystem");
    const key = `${platform === "win32" ? "win32" : "linux"}-x64`;
    const executable = platform === "win32" ? "safe-filesystem.exe" : "safe-filesystem";
    const helperPath = join(helperRoot, key, executable);
    await runSafeFilesystemNativeTest(helperPath);
    console.log(JSON.stringify({ status: "verified", helperPath }));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "safe filesystem native test failed",
      }),
    );
    process.exitCode = 1;
  }
}
