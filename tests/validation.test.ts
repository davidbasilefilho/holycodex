// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vite-plus/test";

import { runFreshClone } from "../scripts/fresh-clone.ts";
import { verifyGeneratedArtifactPortable } from "../scripts/repository-proof.ts";

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
      /runStep\(\["vp", "run", "fmt"/u,
      /runStep\(\["vp", "run", "lint"/u,
      /runStep\(\["vp", "run", "check"/u,
      /runStep\(\["vp", "run", "test"/u,
      /runStep\(\["bun", "scripts\/package-build\.ts"/u,
      /runRepositoryProof/u,
      /runPackageVerification/u,
    ];
    let previous = -1;
    for (const token of order) {
      const relativeIndex = validation.slice(previous + 1).search(token);
      const index = relativeIndex < 0 ? -1 : previous + 1 + relativeIndex;
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(validation).not.toMatch(/runStep\(\["vp", "(?:fmt|lint|check|test)"/u);
  });

  test("keeps CI reusable, least-privilege, cross-platform, and exact-SHA based", async () => {
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
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("inputs.source_sha");
    expect(workflow).toContain("artifact_sha256:");
    expect(workflow).toContain("needs: validate");
    expect(workflow).toContain("package-release.ts create");
    expect(workflow).toContain("release-metadata.json");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("actions/download-artifact@");
    expect(workflow).not.toMatch(
      /packages\/cli\/dist\/assets\/plugin\/(?:agents|compaction|rules)\//u,
    );
    expect(workflow).toContain("packages/cli/dist/assets/plugin/skills/**");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/u);
    expect(workflow).not.toMatch(
      /\b(?:bun\s+publish|gh\s+release\s+create|deploy|trusted publishing)\b/iu,
    );
    for (const checkout of workflow.split("uses: actions/checkout@").slice(1)) {
      expect(checkout).toContain("ref:");
    }
  });

  test("proves development and stable publication channels reuse one exact artifact", async () => {
    const workflow = await readFile(
      resolve(workspaceRoot, ".github/workflows/publish.yml"),
      "utf8",
    );
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("tags:");
    expect(workflow).toContain('"v*.*.*"');
    expect(workflow).toContain('"!v*.*.*-*"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(".github/workflows/validation.yml");
    expect(workflow).toContain("source_sha: ${{ needs.prepare.outputs.source_sha }}");
    expect(workflow).toContain("needs: [prepare, validation]");
    expect(workflow).toContain("needs.validation.outputs.artifact_name");
    expect(workflow).toContain('git rev-parse "${GITHUB_REF}^{commit}"');
    expect(workflow).toContain("GITHUB_RUN_NUMBER");
    expect(workflow).toContain("GITHUB_RUN_ATTEMPT");
    expect(workflow).toContain("release-version.ts dev");
    expect(workflow).toContain("release-version.ts stable");
    expect(workflow).toContain("bunx npm@11.5.1 publish");
    expect(await readFile(resolve(workspaceRoot, "mise.toml"), "utf8")).toContain('node = "26"');
    expect(workflow).not.toContain("bun publish");
    expect(workflow).toContain("actions/download-artifact@");
    expect(workflow).toContain("EXPECTED_SHA256");
    expect(workflow).toContain("scripts/package-release.ts verify");
    expect(workflow).toContain("check-npm");
    expect(workflow).toContain("check-github");
    expect(workflow).toContain('absent|matching) echo "status=$STATUS"');
    expect(workflow).toContain("--tag dev");
    expect(workflow).toContain("--tag latest");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--generate-notes");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NPM_CONFIG_TOKEN");
    expect(workflow).not.toContain("Report unavailable npm publishing credentials");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/u);
    expect(workflow).not.toMatch(/\bnpm\s+(?:install|ci|test|run)\b/u);

    const publishNpm = workflow.slice(
      workflow.indexOf("  publish_npm:"),
      workflow.indexOf("  publish_github:"),
    );
    const publishGithub = workflow.slice(workflow.indexOf("  publish_github:"));
    expect(publishNpm).toContain("absent|matching");
    expect(publishNpm).toContain("contents: read");
    expect(publishNpm).toContain("id-token: write");
    expect(publishNpm).toContain("mise exec -- bunx npm@11.5.1 publish");
    expect(publishNpm).not.toContain("NPM_TOKEN");
    expect(publishNpm).not.toContain("NPM_CONFIG_TOKEN");
    expect(publishGithub).toContain("needs: [prepare, validation, publish_npm]");
    expect(workflow.slice(0, workflow.indexOf("  publish_npm:"))).not.toContain("id-token: write");
    expect(publishGithub).not.toContain("id-token: write");
    expect(workflow.indexOf("  publish_npm:")).toBeLessThan(workflow.indexOf("  publish_github:"));

    const devNpm = workflow.slice(
      workflow.indexOf("Publish the development artifact under dev"),
      workflow.indexOf("Publish the stable artifact under latest"),
    );
    const stableNpm = workflow.slice(workflow.indexOf("Publish the stable artifact under latest"));
    expect(devNpm).toContain("--tag dev");
    expect(devNpm).toContain("bunx npm@11.5.1 publish");
    expect(devNpm).not.toContain("bun publish");
    expect(devNpm).not.toContain("--tag latest");
    expect(stableNpm).toContain("--tag latest");
    expect(stableNpm).toContain("bunx npm@11.5.1 publish");
    expect(stableNpm).not.toContain("bun publish");

    const devRelease = workflow.slice(
      workflow.indexOf("Create the development prerelease at the exact main SHA"),
      workflow.indexOf("Create the stable release from the verified tag"),
    );
    const stableRelease = workflow.slice(
      workflow.indexOf("Create the stable release from the verified tag"),
    );
    expect(devRelease).toContain("--prerelease");
    expect(devRelease).not.toContain("--verify-tag");
    expect(stableRelease).toContain("--verify-tag");
    expect(stableRelease).not.toContain("--prerelease");
    for (const checkout of workflow.split("uses: actions/checkout@").slice(1)) {
      expect(checkout).toContain("ref:");
    }
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

  test("rejects a symlinked generated artifact root or ancestor", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "holycodex-proof-symlink-"));
    const generatedRoot = resolve(workspaceRoot, "packages/codex/generated");
    try {
      const rootLink = join(temporaryRoot, "root-link");
      await symlink(generatedRoot, rootLink);
      await expect(verifyGeneratedArtifactPortable(rootLink)).rejects.toThrow("symlinked roots");

      const targetParent = join(temporaryRoot, "target-parent");
      const linkedParent = join(temporaryRoot, "linked-parent");
      await mkdir(join(targetParent, "generated"), { recursive: true });
      await symlink(targetParent, linkedParent);
      await expect(
        verifyGeneratedArtifactPortable(join(linkedParent, "generated")),
      ).rejects.toThrow("symlinked roots");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
