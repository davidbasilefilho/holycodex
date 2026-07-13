import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, install } from "../src/install";

const originalHome = process.env.CODEX_HOME;
const packageVersion = (
  JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
});

describe("install lifecycle", () => {
  it("preserves unrelated config, removes legacy OMO, and cleans only HolyCodex", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-test-"));
    process.env.CODEX_HOME = home;
    await mkdir(join(home, "plugins", "cache", "sisyphuslabs", "omo"), { recursive: true });
    await writeFile(join(home, "plugins", "cache", "sisyphuslabs", "omo", "old.txt"), "old");
    await writeFile(join(home, "config.toml"), "[custom]\nvalue = true\n");

    const first = await install({ autonomous: false, json: false });
    const installed = await readFile(join(home, "config.toml"), "utf8");
    expect(installed).toContain("[custom]\nvalue = true");
    expect(first.changed).toContain(join(home, "plugins", "cache", "sisyphuslabs", "omo"));
    expect(first.backups.length).toBeGreaterThan(0);
    const cache = join(home, "plugins", "cache", "holycodex", "holycodex", packageVersion);
    const manifest = JSON.parse(
      await readFile(join(cache, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { mcpServers?: unknown };
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(JSON.parse(await readFile(join(cache, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        git_bash: { command: "node", args: ["runtime/git-bash.js", "mcp"], cwd: "." },
        lsp: { command: "node", args: ["runtime/lsp.js", "mcp"], cwd: "." },
        grep_app: { url: "https://mcp.grep.app" },
        context7: { url: "https://mcp.context7.com/mcp" },
      },
    });
    await Promise.all(
      ["git-bash.js", "lsp.js", "rules.js", "bootstrap.js"].map((file) =>
        readFile(join(cache, "runtime", file), "utf8"),
      ),
    );
    const hooks = JSON.parse(await readFile(join(cache, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string }> }>>;
    };
    expect(
      Object.values(hooks.hooks)
        .flat()
        .flatMap((group) => group.hooks.map((hook) => hook.type)),
    ).not.toContain("prompt");
    expect(await readdir(join(cache, "agents"))).not.toHaveLength(0);
    expect(await readdir(join(cache, "skills"))).not.toHaveLength(0);
    expect(installed).toContain("[marketplaces.holycodex]");
    expect(installed).toContain('[plugins."holycodex@holycodex"]\nenabled = true');
    expect((await install({ autonomous: false, json: false })).action).toBe("install");

    await cleanup({ autonomous: false, json: false });
    await cleanup({ autonomous: false, json: false });
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe("[custom]\nvalue = true\n");
  });

  it("removes a config created solely by HolyCodex", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-test-"));
    process.env.CODEX_HOME = home;
    await install({ autonomous: false, json: false });
    await cleanup({ autonomous: false, json: false });
    await expect(readFile(join(home, "config.toml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
