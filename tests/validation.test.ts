// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { runFreshClone } from "../scripts/fresh-clone.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const RootManifestSchema = Schema.Struct({
  packageManager: Schema.Literal("bun@1.4.0"),
  scripts: Schema.Record({ key: Schema.String, value: Schema.String }),
});

describe("repository validation machinery", () => {
  test("keeps one mise/Bun validation command and a deterministic step order", async () => {
    const manifestRaw: unknown = JSON.parse(
      await readFile(resolve(workspaceRoot, "package.json"), "utf8"),
    );
    const manifest = Schema.decodeUnknownEither(RootManifestSchema)(manifestRaw);
    expect(Either.isRight(manifest)).toBe(true);
    if (Either.isLeft(manifest)) {
      throw new Error(String(manifest.left));
    }
    expect(manifest.right.scripts["validate"]).toBe("bun scripts/validate.ts");
    const validation = await readFile(resolve(workspaceRoot, "scripts/validate.ts"), "utf8");
    const order = [
      /runStep\(\["vp", "fmt"/u,
      /runStep\(\["vp", "lint"/u,
      /runStep\(\["vp", "check"/u,
      /runStep\(\["vp", "test"/u,
      /runStep\(\["bun", "scripts\/package-build\.ts"/u,
      /runRepositoryProof/u,
      /runPackageSmoke/u,
    ];
    let previous = -1;
    for (const token of order) {
      const relativeIndex = validation.slice(previous + 1).search(token);
      const index = relativeIndex < 0 ? -1 : previous + 1 + relativeIndex;
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  test("keeps CI thin, least-privilege, cross-platform, and excluded from external writes", async () => {
    const workflow = await readFile(
      resolve(workspaceRoot, ".github/workflows/validation.yml"),
      "utf8",
    );
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("shell: bash");
    expect(workflow).toContain("MSYS_NO_PATHCONV");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run validate");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/u);
    expect(workflow).not.toMatch(/\b(?:publish|deploy|trusted publishing)\b/iu);
  });

  test("proves fresh-clone fixture and dry-run paths do not use the network", async () => {
    await expect(
      runFreshClone({ url: null, ref: null, dryRun: false, fixture: true, network: false }),
    ).resolves.toMatchObject({ mode: "fixture", validation: "skipped" });
    await expect(
      runFreshClone({
        url: "https://example.invalid/holycodex.git",
        ref: "refs/heads/main",
        dryRun: true,
        fixture: false,
        network: false,
      }),
    ).resolves.toMatchObject({ mode: "dry-run", validation: "skipped" });
  });
});
