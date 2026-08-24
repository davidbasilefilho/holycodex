// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { pathWithin } from "./paths.ts";
import {
  assertSafeSessionId,
  assertSafeWorkflowName,
  GeneratedWorkflowStore,
  GeneratedWorkflowStoreError,
} from "./generated-workflow-store.ts";

function testBoundary(platform: "posix" | "win32") {
  return {
    assertOwnedPath: async (root: string, candidate: string, allowMissing: boolean) => {
      if (root !== candidate && !pathWithin(root, candidate, platform)) {
        throw new Error("test boundary escape");
      }
      const entry = await lstat(candidate).catch((error: unknown) => {
        if (
          allowMissing &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      });
      if (entry?.isSymbolicLink()) throw new Error("test boundary symlink");
    },
    ensureDirectory: async (_root: string, candidate: string) => {
      await mkdir(candidate, { recursive: true });
    },
    writeAtomicFile: async (_root: string, candidate: string, bytes: Uint8Array) => {
      await writeFile(candidate, bytes, { mode: 0o600 });
    },
    readOwnedFile: async (_root: string, candidate: string) => {
      const entry = await lstat(candidate);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("test boundary regular file");
      return await readFile(candidate);
    },
    readDirectory: async (_root: string, candidate: string) => {
      const entries = await readdir(candidate, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? ("symlink" as const)
          : entry.isDirectory()
            ? ("directory" as const)
            : ("file" as const),
      }));
    },
    removeOwnedDirectory: async (_root: string, candidate: string) => {
      await rm(candidate, { recursive: true, force: false });
    },
  } as const;
}

function makeStore(root: string, now: () => Date, ttlMs = 60_000): GeneratedWorkflowStore {
  const platform = process.platform === "win32" ? "win32" : "posix";
  return new GeneratedWorkflowStore(root, {
    now,
    ttlMs,
    platform,
    boundary: testBoundary(platform),
  });
}

describe("generated workflow storage boundary", () => {
  test("fails closed when the required native handle primitive is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-generated-no-boundary-"));
    try {
      const platform = process.platform === "win32" ? "win32" : "posix";
      const unavailable = Object.assign(new Error("native helper unavailable"), {
        code: "capability_unavailable",
      });
      const store = new GeneratedWorkflowStore(root, {
        platform,
        boundary: {
          ...testBoundary(platform),
          assertOwnedPath: async () => {
            throw unavailable;
          },
        },
      });
      await expect(store.put("session", "workflow", "export default 1;\n")).rejects.toMatchObject({
        code: "needs_root_decision",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects traversal, absolute, ADS, and unsafe names", () => {
    expect(() => assertSafeSessionId("../escape")).toThrow(GeneratedWorkflowStoreError);
    expect(() => assertSafeWorkflowName("C:\\escape.ts")).toThrow(GeneratedWorkflowStoreError);
    expect(() => assertSafeWorkflowName("workflow:stream")).toThrow(GeneratedWorkflowStoreError);
    expect(() => assertSafeWorkflowName("workflow/name")).toThrow(GeneratedWorkflowStoreError);
    expect(() => assertSafeWorkflowName("workflow name")).toThrow(GeneratedWorkflowStoreError);
  });

  test("stores exact bytes with stable revisions and concurrent identical writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-generated-store-"));
    try {
      const now = () => new Date("2026-08-24T12:00:00.000Z");
      const store = makeStore(root, now);
      const source = "export default 1;\n";
      const [first, second] = await Promise.all([
        store.put("session-a", "workflow", source),
        store.put("session-a", "workflow", source),
      ]);
      expect(first.metadata.source_sha256).toBe(second.metadata.source_sha256);
      expect(first.metadata.source_path).toBe(second.metadata.source_path);
      expect(await readFile(first.metadata.source_path, "utf8")).toBe(source);
      const revision = await store.put("session-a", "workflow", "export default 2;\n");
      expect(revision.metadata.source_path).not.toBe(first.metadata.source_path);
      expect(revision.metadata.owner_session_id).toBe("session-a");
      expect(revision.metadata.source_path).toContain(join("workflows", "session-a"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed on source substitution and malformed metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-generated-integrity-"));
    try {
      const store = makeStore(root, () => new Date("2026-08-24T12:00:00.000Z"));
      const stored = await store.put("session-b", "workflow", "export default 1;\n");
      await writeFile(stored.metadata.source_path, "export default 2;\n");
      await expect(store.read(stored.metadata.source_path)).rejects.toMatchObject({
        code: "integrity_uncertain",
      });
      await writeFile(`${stored.metadata.source_path}.metadata.json`, "{}\n");
      await expect(store.read(stored.metadata.source_path)).rejects.toMatchObject({
        code: "malformed_metadata",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans only exact sessions and expires inactive sessions within bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-generated-cleanup-"));
    try {
      let current = new Date("2026-08-24T12:00:00.000Z");
      const store = makeStore(root, () => current, 1_000);
      const active = await store.put("active", "workflow", "export default 1;\n");
      await store.put("expired", "workflow", "export default 2;\n");
      await store.setSessionActivity("expired", false);
      await store.put("unrelated", "workflow", "export default 3;\n");
      current = new Date("2026-08-24T12:00:02.000Z");
      const result = await store.cleanupExpired({ maxEntries: 10, maxMs: 1000 });
      expect(result.removed).toContain(join(root, "workflows", "expired"));
      expect(result.preserved).toContain(join(root, "workflows", "active"));
      await expect(store.read(active.metadata.source_path)).resolves.toMatchObject({
        source: "export default 1;\n",
      });
      await store.sessionEnd("unrelated");
      await expect(readFile(join(root, "workflows", "unrelated"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a substituted session link before cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-generated-links-"));
    const outside = await mkdtemp(join(tmpdir(), "holycodex-generated-outside-"));
    try {
      const store = makeStore(root, () => new Date("2026-08-24T12:00:00.000Z"));
      await mkdir(join(root, "workflows"), { recursive: true });
      await symlink(
        outside,
        join(root, "workflows", "substituted"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(store.sessionEnd("substituted")).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
