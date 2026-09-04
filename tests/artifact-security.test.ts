// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  runChecked,
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

  test("redacts before deterministic head/tail bounding", () => {
    const secret = "HC_JOIN_MARKER_SECRET";
    const diagnostic = `${"header ".repeat(290)}${secret}${"middle ".repeat(500)}${secret}${"t".repeat(2004)}terminal failure`;
    const redacted = redactDiagnostics(diagnostic, { TOKEN: secret });

    expect(redacted.startsWith("header ")).toBe(true);
    expect(redacted.endsWith("terminal failure")).toBe(true);
    expect(redacted).toContain("...[diagnostic truncated]...");
    expect(redacted).toBe(redactDiagnostics(diagnostic, { TOKEN: secret }));
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(secret.slice(0, 8));
    expect(redacted).not.toContain(secret.slice(-8));
    expect(redacted.length).toBeLessThanOrEqual(4096);
  });

  test("does not split Unicode surrogate pairs at the diagnostic join", () => {
    const diagnostic = `${"a".repeat(2031)}😀${"middle ".repeat(1000)}✅${"b".repeat(2031)}`;
    const redacted = redactDiagnostics(diagnostic);

    expect(redacted.length).toBeLessThanOrEqual(4096);
    for (let index = 0; index < redacted.length; index += 1) {
      const code = redacted.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(redacted.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(redacted.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdfff);
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        expect(redacted.charCodeAt(index - 1)).toBeGreaterThanOrEqual(0xd800);
        expect(redacted.charCodeAt(index - 1)).toBeLessThanOrEqual(0xdbff);
      }
    }
    expect(redacted).toContain("😀");
    expect(redacted).toContain("✅");
  });

  test("keeps successful runChecked results unchanged", async () => {
    const result = await runChecked([process.execPath, "-e", 'process.stdout.write("success")']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("success");
    expect(result.stderr).toBe("");
  });

  test("rejects sensitive package paths at the upload boundary", () => {
    expect(isSensitiveArtifactPath("dist/.env.local")).toBe(true);
    expect(isSensitiveArtifactPath("dist/.npmrc")).toBe(true);
    expect(isSensitiveArtifactPath("terraform/production.tfstate")).toBe(true);
    expect(() => assertBuildUploadEntries(["assets/plugin/.aws/credentials"])).toThrow(
      "sensitive file path",
    );
    expect(() => assertBuildUploadEntries(["assets/plugin/skills/../../escape"])).toThrow(
      "unsafe file path",
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

  test("keeps both public and model-facing executables in the package allowlists", () => {
    expect(() => assertBuildUploadEntries(["index.js", "agent.js"])).not.toThrow();
    expect(() => assertPublicPackageEntries(["dist/index.js", "dist/agent.js"])).not.toThrow();
  });
});
