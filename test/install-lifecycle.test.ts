import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENTS,
  effectiveMcpServers,
  MODEL_ROUTING_PLANS,
  PLAN_NAMES,
  SKILLS,
} from "../packages/cli/src/catalog";
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
  runProcess: async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      installed: [{ pluginId: "codex-security@openai-curated", installed: true, enabled: true }],
      available: [],
    }),
    stderr: "",
    timedOut: false,
    matched: false,
    outputTruncated: false,
  }),
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
  it("installs without Build Web Apps CLI state", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-build-web-apps-"));
    process.env.CODEX_HOME = home;
    await install({ autonomy: "default", json: false }, windowsRuntime);
    await access(join(home, "config.toml"));
  });
  it("preserves older caches while replacing current managed files", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-cache-replacement-"));
    process.env.CODEX_HOME = home;
    const cacheRoot = join(home, "plugins", "cache", "holycodex", "holycodex");
    const olderCache = join(cacheRoot, "0.2.1");
    const currentCache = join(cacheRoot, packageVersion);
    await mkdir(olderCache, { recursive: true });
    await mkdir(join(currentCache, "skills", "lsp", "agents"), { recursive: true });
    await writeFile(join(olderCache, "held.txt"), "held");
    await writeFile(join(currentCache, "stale.txt"), "stale");
    await writeFile(join(currentCache, "skills", "lsp", "agents", "openai.yaml"), "stale");

    await install({ autonomy: "default", json: false }, windowsRuntime);

    await expect(readFile(join(olderCache, "held.txt"), "utf8")).resolves.toBe("held");
    await expect(access(join(currentCache, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await access(join(currentCache, ".codex-plugin", "plugin.json"));
    await expect(
      readFile(join(currentCache, "skills", "lsp", "agents", "openai.yaml"), "utf8"),
    ).resolves.toContain('display_name: "HolyCodex: LSP"');
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
      mcpServers: effectiveMcpServers("win32"),
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
    await Promise.all(
      SKILLS.map((skill) =>
        readFile(join(cache, "skills", skill, "agents", "openai.yaml"), "utf8"),
      ),
    );
    expect(installed).not.toContain("[marketplaces.holycodex]");
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

  it("installs Codex Security idempotently and cleanup leaves it installed", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-codex-security-"));
    process.env.CODEX_HOME = home;
    let installed = false;
    let calls = 0;
    const runtime: InstallRuntime = {
      ...windowsRuntime,
      runProcess: async (input) => {
        calls += 1;
        const isAdd = input.args[1] === "add";
        if (isAdd) installed = true;
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            isAdd
              ? { pluginId: "codex-security@openai-curated" }
              : {
                  installed: installed
                    ? [
                        {
                          pluginId: "codex-security@openai-curated",
                          installed: true,
                          enabled: true,
                        },
                      ]
                    : [],
                  available: installed ? [] : [{ pluginId: "codex-security@openai-curated" }],
                },
          ),
          stderr: "",
          timedOut: false,
          matched: false,
          outputTruncated: false,
        };
      },
    };

    await expect(install({ autonomy: "default", json: true }, runtime)).resolves.toMatchObject({
      codexSecurity: { status: "installed" },
    });
    await expect(install({ autonomy: "default", json: true }, runtime)).resolves.toMatchObject({
      codexSecurity: { status: "already-installed" },
    });
    const callsBeforeCleanup = calls;
    await cleanup({ autonomy: "default", json: true });
    expect(installed).toBe(true);
    expect(calls).toBe(callsBeforeCleanup);
  });

  it("completes HolyCodex installation when Codex is unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-codex-unavailable-"));
    process.env.CODEX_HOME = home;
    const runtime: InstallRuntime = {
      ...windowsRuntime,
      runProcess: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        matched: false,
        outputTruncated: false,
        error: "spawn codex ENOENT",
      }),
    };
    const result = await install({ autonomy: "default", json: true }, runtime);
    expect(result.codexSecurity).toEqual({
      status: "skipped",
      reason: "codex-unavailable",
    });
    await access(join(home, "config.toml"));
  });

  it("omits effective Git Bash configuration and prompts off Windows", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-linux-test-"));
    process.env.CODEX_HOME = home;
    const linuxRuntime: InstallRuntime = {
      ...windowsRuntime,
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
    expect(worker).toContain('model = "gpt-5.6-luna"');
    expect(worker).toContain('model_reasoning_effort = "xhigh"');
  });

  it("preserves unrelated agent settings while refreshing managed profile content", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-agent-settings-test-"));
    process.env.CODEX_HOME = home;
    const agents = join(home, "holycodex", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "explorer.toml"),
      'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "high"\ncustom_root = "keep"\n[custom]\nenabled = true\n',
    );

    await install({ autonomy: "default", fast: "fast", json: false }, windowsRuntime);

    const explorer = await readFile(join(agents, "explorer.toml"), "utf8");
    expect(explorer).toContain('custom_root = "keep"');
    expect(explorer).toContain("[custom]\nenabled = true");
    expect(explorer).toContain('service_tier = "fast"');
    expect(explorer).toContain("Begin with requested evidence");
  });

  it("migrates former global Fast state to explicit Root and agent tiers idempotently", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-old-global-fast-test-"));
    process.env.CODEX_HOME = home;
    await install({ autonomy: "default", fast: "fast-all", json: false }, windowsRuntime);
    const configPath = join(home, "config.toml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace("# holycodex fast: fast-all\n", ""),
    );

    await install({ autonomy: "default", fast: "fast", json: false }, windowsRuntime);
    const once = await readFile(configPath, "utf8");
    expect(once).toContain("# holycodex fast: fast");
    expect(once).toContain('service_tier = "default"');
    for (const agent of AGENTS)
      expect(await readFile(join(home, "holycodex", "agents", `${agent}.toml`), "utf8")).toContain(
        'service_tier = "fast"',
      );

    await install({ autonomy: "default", fast: "fast", json: false }, windowsRuntime);
    expect(await readFile(configPath, "utf8")).toBe(once);
  });

  it("preserves an override that matches a different routing plan", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-agent-plan-override-test-"));
    process.env.CODEX_HOME = home;
    await install({ autonomy: "default", json: false, plan: "plus" }, windowsRuntime);
    const explorerPath = join(home, "holycodex", "agents", "explorer.toml");
    const proRoute = MODEL_ROUTING_PLANS["pro-5x"].agents.explorer;
    await writeFile(
      explorerPath,
      `model = "${proRoute.model}"\nmodel_reasoning_effort = "${proRoute.reasoningEffort}"\n`,
    );

    await install({ autonomy: "default", json: false, plan: "plus" }, windowsRuntime);

    const explorer = await readFile(explorerPath, "utf8");
    expect(explorer).toContain(`model = "${proRoute.model}"`);
    expect(explorer).toContain(`model_reasoning_effort = "${proRoute.reasoningEffort}"`);
  });

  it("migrates old managed pro-20x specialist routes", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-old-pro-20x-route-test-"));
    process.env.CODEX_HOME = home;
    await install({ autonomy: "default", json: false, plan: "pro-20x" }, windowsRuntime);
    await writeFile(
      join(home, "holycodex", "agents", "explorer.toml"),
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n',
    );

    await install({ autonomy: "default", json: false, plan: "plus" }, windowsRuntime);

    const explorer = await readFile(join(home, "holycodex", "agents", "explorer.toml"), "utf8");
    const route = MODEL_ROUTING_PLANS.plus.agents.explorer;
    expect(explorer).toContain(`model = "${route.model}"`);
    expect(explorer).toContain(`model_reasoning_effort = "${route.reasoningEffort}"`);
  });

  it("migrates every outgoing specialist route to the recalculated plan", async () => {
    const outgoingPlans = [
      [
        "plus-low",
        [
          ["explorer", "gpt-5.6-luna", "low"],
          ["librarian", "gpt-5.6-luna", "medium"],
          ["worker", "gpt-5.6-terra", "medium"],
        ],
      ],
      [
        "plus",
        [
          ["explorer", "gpt-5.6-luna", "medium"],
          ["librarian", "gpt-5.6-terra", "medium"],
          ["worker", "gpt-5.6-terra", "high"],
        ],
      ],
      [
        "plus-high",
        [
          ["explorer", "gpt-5.6-luna", "high"],
          ["librarian", "gpt-5.6-luna", "high"],
          ["worker", "gpt-5.6-terra", "high"],
        ],
      ],
      [
        "pro-5x",
        [
          ["explorer", "gpt-5.6-luna", "high"],
          ["librarian", "gpt-5.6-terra", "high"],
          ["worker", "gpt-5.6-sol", "medium"],
        ],
      ],
      [
        "pro-20x",
        [
          ["librarian", "gpt-5.6-sol", "medium"],
          ["worker", "gpt-5.6-sol", "high"],
        ],
      ],
    ] as const;

    for (const [plan, routes] of outgoingPlans) {
      const home = await mkdtemp(join(tmpdir(), `holycodex-old-${plan}-routes-test-`));
      process.env.CODEX_HOME = home;
      await install({ autonomy: "default", json: false, plan }, windowsRuntime);
      await Promise.all(
        routes.map(([agent, model, reasoningEffort]) =>
          writeFile(
            join(home, "holycodex", "agents", `${agent}.toml`),
            `model = "${model}"\nmodel_reasoning_effort = "${reasoningEffort}"\n`,
          ),
        ),
      );

      await install({ autonomy: "default", json: false, plan }, windowsRuntime);

      for (const [agent] of routes) {
        const source = await readFile(join(home, "holycodex", "agents", `${agent}.toml`), "utf8");
        const route = MODEL_ROUTING_PLANS[plan].agents[agent];
        expect(source).toContain(`model = "${route.model}"`);
        expect(source).toContain(`model_reasoning_effort = "${route.reasoningEffort}"`);
      }
    }
  });

  it("migrates an installed old go Root route", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-old-go-root-route-test-"));
    process.env.CODEX_HOME = home;
    const configPath = join(home, "config.toml");
    await install({ autonomy: "default", json: false, plan: "go" }, windowsRuntime);
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8"))
        .replace('model = "gpt-5.6-terra"', 'model = "gpt-5.6-sol"')
        .replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "low"'),
    );

    await install({ autonomy: "default", json: false, plan: "go" }, windowsRuntime);

    const config = await readFile(configPath, "utf8");
    expect(config).toContain("# holycodex plan: go");
    expect(config).toContain('model = "gpt-5.6-terra"');
    expect(config).toContain('model_reasoning_effort = "medium"');
    expect(config).not.toContain('model = "gpt-5.6-sol"');
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
      expect(config).toContain("multi_agent = true");
      expect(config).toContain("multi_agent_v2 = true");
      expect(config).toContain(`max_threads = ${MODEL_ROUTING_PLANS[plan].usage.maxSubagents + 1}`);
      expect(config).toContain(`max_depth = ${MODEL_ROUTING_PLANS[plan].usage.maxDepth}`);
      for (const agent of AGENTS) {
        const source = await readFile(join(home, "holycodex", "agents", `${agent}.toml`), "utf8");
        const route = MODEL_ROUTING_PLANS[plan].agents[agent];
        expect(source).toContain(`model = "${route.model}"`);
        expect(source).toContain(`model_reasoning_effort = "${route.reasoningEffort}"`);
      }
    }
  });
});
