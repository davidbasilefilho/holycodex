// SPDX-License-Identifier: Apache-2.0

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  assertBuildUploadEntries,
  assertPublicPackageEntries,
  assertReleaseOutputDirectory,
  assertSafeArtifactFile,
  listSafeArtifactEntries,
  isSensitiveArtifactPath,
} from "../scripts/artifact-security.ts";
import {
  allowlistedEnvironment,
  redactDiagnostics,
  withTemporaryDirectory,
} from "../scripts/process.ts";

describe("artifact and diagnostic security boundaries", () => {
  test("does not copy an unallowlisted environment secret and redacts key-aware diagnostics", () => {
    const key = "HOLYCODEX_SECURITY_TEST_SECRET";
    const sentinel = "HC_SECRET_SENTINEL_VALUE";
    const previous = process.env[key];
    process.env[key] = sentinel;
    try {
      const selected = allowlistedEnvironment(["PATH"]);
      expect(selected[key]).toBeUndefined();

      const redacted = redactDiagnostics(
        `HOLYCODEX_SECURITY_TEST_SECRET=${sentinel} --token ${sentinel}`,
        { [key]: sentinel },
      );
      expect(redacted.includes(sentinel)).toBe(false);
      expect(redacted.includes("[REDACTED]")).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  test("rejects sensitive package paths at the upload boundary", () => {
    expect(isSensitiveArtifactPath("dist/.env.local")).toBe(true);
    expect(isSensitiveArtifactPath("dist/.npmrc")).toBe(true);
    expect(isSensitiveArtifactPath("terraform/production.tfstate")).toBe(true);
    expect(() => assertBuildUploadEntries(["assets/plugin/.aws/credentials"])).toThrow(
      "sensitive file path",
    );
    expect(() => assertPublicPackageEntries(["dist/index.js", "dist/.env.local"])).toThrow(
      "sensitive file path",
    );
  });

  test("rejects a secret value even when a copied file has an ordinary name", async () => {
    const key = "HOLYCODEX_SECURITY_CONTENT_SECRET";
    const sentinel = "HC_CONTENT_SECRET_SENTINEL_VALUE";
    const previous = process.env[key];
    process.env[key] = sentinel;
    try {
      await withTemporaryDirectory("holycodex-artifact-content", async (directory) => {
        const path = join(directory, "ordinary.md");
        await writeFile(path, `content: ${sentinel}\n`);
        await expect(assertSafeArtifactFile(path, "ordinary.md", "the package")).rejects.toThrow(
          "environment secret value",
        );
      });
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  test("rejects short secret values and symlinked artifact roots", async () => {
    const key = "HOLYCODEX_SECURITY_SHORT_SECRET";
    const previous = process.env[key];
    process.env[key] = "x";
    try {
      await withTemporaryDirectory("holycodex-artifact-short-secret", async (directory) => {
        const path = join(directory, "ordinary.md");
        await writeFile(path, "x\n");
        await expect(assertSafeArtifactFile(path, "ordinary.md", "the package")).rejects.toThrow(
          "environment secret value",
        );
      });
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    await withTemporaryDirectory("holycodex-artifact-symlink", async (directory) => {
      const outside = join(directory, "outside");
      const link = join(directory, "link");
      await mkdir(outside);
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      await expect(listSafeArtifactEntries(link, "the package")).rejects.toThrow("symbolic links");
    });
  });

  test("requires release output to contain only its tarball and identity metadata", async () => {
    await withTemporaryDirectory("holycodex-artifact-security", async (directory) => {
      const tarball = "holycodex-1.2.3.tgz";
      await writeFile(join(directory, tarball), "archive");
      await writeFile(join(directory, "release-metadata.json"), "{}\n");
      await expect(assertReleaseOutputDirectory(directory, tarball)).resolves.toBeUndefined();

      await mkdir(join(directory, "nested"));
      await writeFile(join(directory, "nested", ".npmrc"), "ignored\n");
      await expect(assertReleaseOutputDirectory(directory, tarball)).rejects.toThrow(
        "sensitive file path",
      );
    });
  });
});
