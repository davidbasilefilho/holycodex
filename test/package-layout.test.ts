import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { VERSION } from "../packages/cli/src/catalog.ts";
import { CODEX_SLIM_EDIT_VERSION } from "../packages/codexslimedit/src/version.ts";
import { pluginRoot as resolvedPluginRoot } from "../packages/plugin/index.js";

const root = join(import.meta.dirname, "..");
const run = promisify(execFile);

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

  it("keeps codexslimedit independently versioned and publishable", async () => {
    const slimEdit = await json("packages/codexslimedit/package.json");
    expect(slimEdit).toMatchObject({
      name: "codexslimedit",
      version: CODEX_SLIM_EDIT_VERSION,
      bin: { codexslimedit: "dist/cli.js" },
      publishConfig: { access: "public" },
      engines: { node: ">=20" },
    });
    expect("private" in slimEdit).toBe(false);
    expect(CODEX_SLIM_EDIT_VERSION).not.toBe(VERSION);
  });

  it("resolves the plugin payload through its public package entry", async () => {
    expect(resolvedPluginRoot.replaceAll("\\", "/").endsWith("/packages/plugin/plugin")).toBe(true);
    expect(
      await readFile(join(resolvedPluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ).toContain(`"version": "${VERSION}"`);
  });

  it("runs installed LSP detection without external package resolution", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "holycodex-installed-plugin-"));
    const installedPlugin = join(fixture, "plugin");
    const project = join(fixture, "project");
    await cp(resolvedPluginRoot, installedPlugin, { recursive: true });
    await mkdir(project);
    await writeFile(join(project, "example.ts"), "export const example = true;\n");

    const result = await run(
      process.execPath,
      [join(installedPlugin, "skills", "lsp-setup", "scripts", "detect-lsp.ts"), project, "--json"],
      { cwd: project },
    );
    const output = JSON.parse(result.stdout) as {
      results: Array<{ server: { language: string } }>;
    };
    expect(output.results.some((item) => item.server.language === "typescript")).toBe(true);
  });

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
  it("uses one trusted workflow for stable and dev publication", async () => {
    const workflowDirectory = join(root, ".github", "workflows");
    const publishingWorkflows: string[] = [];
    for (const file of await readdir(workflowDirectory)) {
      const source = await readFile(join(workflowDirectory, file), "utf8");
      if (source.includes("npm publish")) publishingWorkflows.push(file);
    }
    expect(publishingWorkflows).toEqual(["publish.yml"]);

    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("- dev");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("npm@11.5.1");
    expect(workflow).toContain('registry-url: "https://registry.npmjs.org"');
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("group: npm-publish-${{ github.ref_name }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm whoami/);
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("gh release view");
  });

  it("keeps validation ahead of branch-specific publication", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("bunx vp check --fix");
    expect(workflow).toContain("bunx vp test");
    expect(workflow).toContain("node packages/codexslimedit/dist/cli.js --version");
    expect(workflow).toContain("bun packages/codexslimedit/dist/cli.js --version");
    expect(workflow.indexOf("bunx vp run build")).toBeLessThan(workflow.indexOf("bunx vp test"));
    expect(workflow.indexOf("bunx vp test")).toBeLessThan(
      workflow.indexOf("npm publish ./packages/plugin"),
    );
  });

  it("publishes stable versions under latest and skips versions already present", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("github.ref_name == 'main'");
    expect(workflow).toContain("npm view");
    expect(workflow.match(/--tag latest/g)).toHaveLength(3);
    expect(
      workflow.indexOf("npm publish ./packages/codexslimedit --access public --tag latest"),
    ).toBeLessThan(workflow.indexOf("npm publish ./packages/plugin --access public --tag latest"));
    expect(
      workflow.indexOf("npm publish ./packages/plugin --access public --tag latest"),
    ).toBeLessThan(workflow.indexOf("npm publish ./packages/cli --tag latest"));
  });

  it("publishes unique dev versions under only the dev dist-tag", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("github.ref_name == 'dev'");
    expect(workflow).toContain("GITHUB_RUN_ID");
    expect(workflow).toContain("GITHUB_RUN_ATTEMPT");
    expect(workflow).toContain(
      'DEV_VERSION="${BASE_VERSION}-dev.${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}"',
    );
    expect(workflow).toContain('npm version "$DEV_VERSION" --no-git-tag-version');
    expect(workflow.indexOf("bunx vp check --fix")).toBeLessThan(
      workflow.indexOf("Derive unique dev version"),
    );
    expect(workflow.indexOf("Derive unique dev version")).toBeLessThan(
      workflow.indexOf("bunx vp run build"),
    );
    expect(
      workflow.indexOf("npm publish ./packages/plugin --access public --tag dev"),
    ).toBeLessThan(workflow.indexOf("npm publish ./packages/cli --tag dev"));
    expect(workflow.match(/--tag dev/g)).toHaveLength(2);
  });
});
