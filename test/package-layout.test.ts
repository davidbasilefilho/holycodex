import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { VERSION } from "../packages/cli/src/catalog.ts";
import { pluginRoot as resolvedPluginRoot } from "../packages/plugin/index.js";

const root = join(import.meta.dirname, "..");
const run = promisify(execFile);
const generatedRuntimeAvailable = await access(
  join(resolvedPluginRoot, "runtime", "core-instructions.js"),
).then(
  () => true,
  () => false,
);

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, path), "utf8")) as Record<string, unknown>;
}

describe("public package layout", () => {
  it("keeps the root private and public package versions synchronized", async () => {
    const workspace = await json("package.json");
    const cli = await json("packages/cli/package.json");
    const plugin = await json("packages/plugin/package.json");
    expect(workspace).toMatchObject({
      name: "holycodex-workspace",
      private: true,
      version: VERSION,
    });
    expect(cli).toMatchObject({ name: "holycodex", version: VERSION });
    expect(plugin).toMatchObject({ name: "@holycodex/plugin", version: VERSION });
    expect((cli["dependencies"] as Record<string, string>)["@holycodex/plugin"]).toBe(VERSION);
  });

  it("resolves the plugin payload through its public package entry", async () => {
    expect(resolvedPluginRoot.replaceAll("\\", "/").endsWith("/packages/plugin/plugin")).toBe(true);
    expect(
      await readFile(join(resolvedPluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ).toContain(`"version": "${VERSION}"`);
  });

  it.runIf(generatedRuntimeAvailable)(
    "runs installed LSP detection without external package resolution",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "holycodex-installed-plugin-"));
      const installedPlugin = join(fixture, "plugin");
      const project = join(fixture, "project");
      await cp(resolvedPluginRoot, installedPlugin, { recursive: true });
      await mkdir(project);
      await writeFile(join(project, "example.ts"), "export const example = true;\n");

      const result = await run(
        process.execPath,
        [
          join(installedPlugin, "skills", "lsp-setup", "scripts", "detect-lsp.ts"),
          project,
          "--json",
        ],
        { cwd: project },
      );
      const output = JSON.parse(result.stdout) as {
        results: Array<{ server: { language: string } }>;
      };
      expect(output.results.some((item) => item.server.language === "typescript")).toBe(true);
    },
  );

  it("points the repository marketplace at the packaged plugin", async () => {
    const marketplace = await json("marketplace.json");
    const plugins = marketplace["plugins"] as Array<{ source: string }>;
    expect(plugins[0]?.source).toBe("./packages/plugin/plugin");
  });

  it("keeps public package legal notices synchronized", async () => {
    for (const file of ["LICENSE.md", "THIRD-PARTY-NOTICES.md"]) {
      const canonical = await readFile(join(root, file), "utf8");
      expect(await readFile(join(root, "packages", "cli", file), "utf8")).toBe(canonical);
      expect(await readFile(join(root, "packages", "plugin", file), "utf8")).toBe(canonical);
    }
  });
});

describe("npm release workflows", () => {
  it("uses one trusted workflow for main dev and tagged stable publication", async () => {
    const workflowDirectory = join(root, ".github", "workflows");
    const publishingWorkflows: string[] = [];
    for (const file of await readdir(workflowDirectory)) {
      const source = await readFile(join(workflowDirectory, file), "utf8");
      if (source.includes("scripts/publish.mjs")) publishingWorkflows.push(file);
    }
    expect(publishingWorkflows).toEqual(["publish.yml"]);

    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("- main");
    expect(workflow).not.toContain("- dev");
    expect(workflow).toContain('- "v*"');
    expect(workflow).toContain("GITHUB_RUN_ID");
    expect(workflow).toContain("GITHUB_RUN_ATTEMPT");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("description: Exact stable tag ref");
    expect(workflow).toContain("stable:");
    expect(workflow).toContain("default: true");
    expect(workflow).toContain("Validate manual release authorization");
    expect(workflow).toContain("stable=true is required when dry_run=false");
    expect(workflow).toContain("inputs.ref || github.ref");
    expect(workflow).not.toContain("inputs.ref || github.sha");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("npm@11.5.1");
    expect(workflow).toContain('registry-url: "https://registry.npmjs.org"');
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("github.run_id");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm whoami/);
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("gh release view");
  });

  it("keeps validation ahead of branch-specific publication", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("bunx vp check --fix");
    expect(workflow).toContain("git diff --exit-code");
    expect(workflow.indexOf("bunx vp check --fix")).toBeLessThan(
      workflow.indexOf("git diff --exit-code"),
    );
    expect(workflow).toContain("expected-release.diff");
    expect(workflow).toContain("actual-release.diff");
    expect(workflow.indexOf("bun scripts/version.mjs dev")).toBeLessThan(
      workflow.indexOf("expected-release.diff"),
    );
    expect(workflow.indexOf("expected-release.diff")).toBeLessThan(
      workflow.indexOf("bunx vp run build"),
    );
    expect(workflow.match(/bunx vp run build/g)).toHaveLength(1);
    expect(workflow).toContain("bunx vp test");
    expect(workflow.indexOf("bunx vp run build")).toBeLessThan(workflow.indexOf("bunx vp test"));
    expect(workflow.indexOf("bunx vp test")).toBeLessThan(
      workflow.indexOf("bun scripts/publish.mjs stable"),
    );
  });

  it("publishes stable versions from exact tags through the shared guarded implementation", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("startsWith(env.RELEASE_REF, 'refs/tags/v')");
    expect(workflow).toContain("git rev-parse HEAD");
    expect(workflow).toContain('git rev-parse "${RELEASE_REF}^{}"');
    expect(workflow).not.toContain('git rev-parse \\"$RELEASE_REF^{}\\"');
    expect(workflow).toContain('test "$RELEASE_REF" = "refs/tags/v${VERSION}"');
    expect(workflow).toContain("bun scripts/publish.mjs stable");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("title=GitHub release");
    expect(workflow).toContain('--target "$(git rev-parse HEAD)"');
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
    expect(workflow.indexOf("bun scripts/publish.mjs stable")).toBeLessThan(
      workflow.indexOf("gh release create"),
    );
  });

  it("publishes every main push under a unique dev version", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain(
      'bun scripts/version.mjs dev "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"',
    );
    expect(workflow).toContain("bun scripts/publish.mjs dev");
  });

  it("waits for package visibility and verifies exact versions and dist-tags", async () => {
    const publisher = await readFile(join(root, "scripts", "publish.mjs"), "utf8");
    expect(publisher).toContain("visibilityAttempts = 12");
    expect(publisher).toContain("waitForRegistryIntegrity");
    expect(publisher).toContain("waitForPublicationVerification");
    expect(publisher.indexOf("waitForRegistryIntegrity")).toBeLessThan(
      publisher.indexOf("verifyPublication"),
    );
    expect(publisher).toContain("dist-tags.${channel}");
    expect(publisher).toContain('publicationSummary(item, channel, "verified")');
    expect(publisher).toContain("result=${result} tag=${channel}");
    expect(publisher).toContain("GITHUB_STEP_SUMMARY");
    expect(publisher).not.toContain("item.name === plugin.name && !dryRun");
  });
});
