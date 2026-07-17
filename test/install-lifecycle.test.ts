import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENTS, MODEL_ROUTING_PLANS, PLAN_NAMES } from "../packages/cli/src/catalog";
import {
  assertGitBashReady,
  cleanup,
  install,
  type InstallRuntime,
} from "../packages/cli/src/install";

const originalHome = process.env.CODEX_HOME;
const packageVersion = (
  JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const windowsRuntime: InstallRuntime = {
  platform: "win32",
  gitBash: () => ({ found: true, path: "bash.exe", source: "env", checkedPaths: [] }),
};

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
});

describe("install lifecycle", () => {
  it("blocks install before mutation when native Windows lacks Git Bash", () => {
    expect(() =>
      assertGitBashReady("win32", {
        found: false,
        checkedPaths: [],
        installHint: "Install Git Bash.",
      }),
    ).toThrow("Install Git Bash.");
  });
  it("preserves unrelated config, removes legacy OMO, and cleans only HolyCodex", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-test-"));
    process.env.CODEX_HOME = home;
    await mkdir(join(home, "plugins", "cache", "sisyphuslabs", "omo"), { recursive: true });
    await writeFile(join(home, "plugins", "cache", "sisyphuslabs", "omo", "old.txt"), "old");
    await writeFile(join(home, "config.toml"), "[custom]\nvalue = true\n");

    const first = await install({ autonomy: "default", json: false }, windowsRuntime);
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
        git_bash: {
          command: "node",
          args: ["runtime/git-bash.js", "mcp"],
          cwd: ".",
          enabled_tools: ["run"],
        },
        lsp: { command: "node", args: ["runtime/lsp.js", "mcp"], cwd: "." },
        context7: { command: "bunx", args: ["@upstash/context7-mcp"] },
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
    expect((await install({ autonomy: "default", json: false }, windowsRuntime)).action).toBe(
      "install",
    );

    const staleCache = join(home, "plugins", "cache", "holycodex", "holycodex", "0.2.1");
    await mkdir(staleCache, { recursive: true });
    await writeFile(join(staleCache, "hooks.json"), '{"type":"prompt"}');

    await cleanup({ autonomy: "default", json: false });
    await cleanup({ autonomy: "default", json: false });
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe("[custom]\nvalue = true\n");
    await expect(access(join(home, "plugins", "cache", "holycodex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes a config created solely by HolyCodex", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-test-"));
    process.env.CODEX_HOME = home;
    await install({ autonomy: "default", json: false }, windowsRuntime);
    await cleanup({ autonomy: "default", json: false });
    await expect(readFile(join(home, "config.toml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("omits effective Git Bash configuration and prompts off Windows", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-linux-test-"));
    process.env.CODEX_HOME = home;
    const linuxRuntime: InstallRuntime = {
      platform: "linux",
      gitBash: () => ({ found: false, checkedPaths: [], installHint: "irrelevant" }),
    };
    await install({ autonomy: "default", json: false }, linuxRuntime);
    const cache = join(home, "plugins", "cache", "holycodex", "holycodex", packageVersion);
    const mcp = JSON.parse(await readFile(join(cache, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers.git_bash).toBeUndefined();
    expect(mcp.mcpServers.lsp).toBeDefined();
    for (const agent of await readdir(join(cache, "agents"))) {
      const prompt = await readFile(join(cache, "agents", agent), "utf8");
      expect(prompt).not.toContain("mcp__git_bash__run");
    }
  });

  it("preserves explicit named-agent model preferences but migrates known defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-agent-model-test-"));
    process.env.CODEX_HOME = home;
    const agents = join(home, "holycodex", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "explorer.toml"),
      "  model = 'user/explorer'\n\tmodel_reasoning_effort = 'high'\n",
    );
    await writeFile(
      join(agents, "worker.toml"),
      'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\n',
    );
    await install({ autonomy: "default", json: false }, windowsRuntime);
    const explorer = await readFile(join(agents, "explorer.toml"), "utf8");
    const worker = await readFile(join(agents, "worker.toml"), "utf8");
    expect(explorer).toContain('model = "user/explorer"');
    expect(explorer).toContain('model_reasoning_effort = "high"');
    expect(worker).toContain('model = "gpt-5.6-terra"');
    expect(worker).toContain('model_reasoning_effort = "high"');
  });

  it("renders every plan and updates managed specialist routing on reinstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-routing-plan-test-"));
    process.env.CODEX_HOME = home;
    await writeFile(join(home, "config.toml"), "[custom]\nvalue = true\n");
    for (const plan of PLAN_NAMES) {
      await install({ autonomy: "default", json: false, plan }, windowsRuntime);
      const config = await readFile(join(home, "config.toml"), "utf8");
      expect(config).toContain(`# holycodex plan: ${plan}`);
      expect(config).toContain("[custom]\nvalue = true");
      for (const agent of AGENTS) {
        const source = await readFile(join(home, "holycodex", "agents", `${agent}.toml`), "utf8");
        const route = MODEL_ROUTING_PLANS[plan].agents[agent];
        expect(source).toContain(`model = "${route.model}"`);
        expect(source).toContain(`model_reasoning_effort = "${route.reasoningEffort}"`);
      }
    }
  });
});
