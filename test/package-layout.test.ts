import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("package and release layout", () => {
  it("keeps public package versions synchronized", async () => {
    const manifests = await Promise.all(
      [
        "package.json",
        "packages/cli/package.json",
        "packages/plugin/package.json",
        "packages/lsp-daemon/package.json",
        "packages/lsp-core/package.json",
        "packages/git-bash/package.json",
        "packages/runtime-core/package.json",
        "packages/workflow-host/package.json",
        "packages/workflow-runtime/package.json",
      ].map(
        async (path) => JSON.parse(await readFile(join(root, path), "utf8")) as { version: string },
      ),
    );
    expect(new Set(manifests.map((manifest) => manifest.version)).size).toBe(1);
  });

  it("ships the plugin payload without an MCP manifest", async () => {
    const plugin = join(root, "packages", "plugin", "plugin");
    await expect(access(join(plugin, ".codex-plugin", "plugin.json"))).resolves.toBeUndefined();
    await expect(access(join(plugin, ".mcp.json"))).rejects.toBeDefined();
  });

  it("uses one workflow with read-only validation and isolated publication permissions", async () => {
    expect(await readdir(join(root, ".github", "workflows"))).toEqual(["publish.yml"]);
    const workflow = await readFile(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain('node-version: "26"');
    expect(workflow).toContain("vite-plus@0.2.7 vp check");
    expect(workflow).not.toContain("vp check --fix");
    expect(workflow).toContain("os: [ubuntu-latest, windows-latest]");
    expect(workflow).toContain("runs-on: macos-latest");
    expect(workflow).toContain("Validate packed install, doctor, and cleanup");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
  });
});
