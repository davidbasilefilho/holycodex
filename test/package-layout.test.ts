import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../packages/cli/src/catalog.ts";
import { pluginRoot as resolvedPluginRoot } from "../packages/plugin/index.js";

const root = join(import.meta.dirname, "..");

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
  it("publishes stable plugin before CLI through OIDC", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("bunx vp check");
    expect(workflow).toContain("bunx vp test");
    expect(workflow.indexOf("npm publish ./packages/plugin")).toBeLessThan(
      workflow.indexOf("npm publish ./packages/cli"),
    );
    expect(workflow).not.toContain("--tag dev");
  });

  it("publishes unique dev versions under the dev dist-tag", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "dev.yml"), "utf8");
    expect(workflow).toContain("- dev");
    expect(workflow).toContain("github.run_number");
    expect(workflow).toContain("github.run_attempt");
    expect(workflow).toContain("secrets.NPM_TOKEN");
    expect(workflow.indexOf("bunx vp check")).toBeLessThan(
      workflow.indexOf("Derive unique dev version"),
    );
    expect(workflow.indexOf("npm publish ./packages/plugin")).toBeLessThan(
      workflow.indexOf("npm publish ./packages/cli"),
    );
    expect(workflow.match(/--tag dev/g)).toHaveLength(2);
  });
});
