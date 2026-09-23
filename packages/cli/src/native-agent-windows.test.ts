// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import {
  AppServerClient,
  CODEX_PROTOCOL_VERSION,
  readTomlPath,
  type AsyncLineTransport,
} from "@holycodex/codex";

import {
  installHolyCodex,
  projectNativeAgents,
  projectRootAgent,
  renderNativeAgent,
  rootDeveloperInstructions,
  windowsGitBashShellDirective,
  WINDOWS_GIT_BASH,
  type InstallerRuntime,
  type OfficialPluginManager,
} from "./index.ts";
import { parseConfig } from "./installer.ts";
import { inspectNativeAgentConflicts } from "./native-agents.ts";

const verifiedPathBash = "C:\\Other\\Git\\bin\\bash.exe";

class ConfigReadTransport implements AsyncLineTransport {
  private readonly queued: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(private readonly config: ReturnType<typeof parseConfig>) {}

  async readLine(): Promise<string | null> {
    const line = this.queued.shift();
    if (line !== undefined) return line;
    if (this.closed) return null;
    return await new Promise((resolve) => this.waiters.push(resolve));
  }

  async writeLine(line: string): Promise<void> {
    const request = JSON.parse(line) as { id?: number; method?: string };
    if (request.method === "initialized" || request.id === undefined) return;
    if (request.method === "initialize") {
      this.enqueue({
        id: request.id,
        result: {
          userAgent: `codex-cli ${CODEX_PROTOCOL_VERSION.slice("codex-cli-".length)}`,
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "linux",
          serverInfo: {
            name: "codex",
            version: CODEX_PROTOCOL_VERSION.slice("codex-cli-".length),
          },
        },
      });
      return;
    }
    if (request.method === "config/read") {
      this.enqueue({
        id: request.id,
        result: { config: this.config, origins: {}, layers: null },
      });
      return;
    }
    throw new Error(`Unexpected App Server request: ${String(request.method)}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const resolve of this.waiters.splice(0)) resolve(null);
  }

  private enqueue(value: unknown): void {
    const line = JSON.stringify(value);
    const resolve = this.waiters.shift();
    if (resolve === undefined) this.queued.push(line);
    else resolve(line);
  }
}

function windowsRuntime(): InstallerRuntime {
  const processPath = "C:\\Users\\Test\\.bun\\bin\\bun.exe";
  const binRoot = "C:\\Users\\Test\\.bun\\bin";
  const projectRoot = win32.join(win32.dirname(binRoot), "install", "global");
  const packageRoot = win32.join(
    win32.dirname(binRoot),
    "install",
    "global",
    "node_modules",
    "ctx7",
  );
  const packageExecutable = win32.join(packageRoot, "dist", "index.js");
  const shim = win32.join(binRoot, "ctx7.exe");
  const gitExecutable = "C:\\Other\\Git\\cmd\\git.exe";
  const files = {
    access: async (path: string): Promise<void> => {
      if ([binRoot, projectRoot, packageRoot, packageExecutable, shim].includes(path)) {
        return;
      }
      throw new Error(`missing: ${path}`);
    },
    readText: async (path: string): Promise<string> => {
      if (path !== win32.join(packageRoot, "package.json")) throw new Error(`missing: ${path}`);
      return JSON.stringify({ version: "2.0.0", bin: { ctx7: "dist/index.js" } });
    },
    realpath: async (path: string): Promise<string> => path,
  };
  return {
    platform: "win32",
    environment: { PATH: [`C:\\Other\\Git\\bin`, binRoot].join(";") },
    processPath,
    files,
    run: async (executable, args) => {
      if (executable === processPath && args.join(" ") === "pm bin -g") {
        return { exitCode: 0, stdout: `${binRoot}\n`, stderr: "" };
      }
      if (executable === processPath && args.join(" ") === "add -g ctx7@latest") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (executable === shim && args[0] === "--version") {
        return { exitCode: 0, stdout: "ctx7 2.0.0\n", stderr: "" };
      }
      if (executable === verifiedPathBash && args[0] === "--version") {
        return { exitCode: 0, stdout: "GNU bash, version 5.2.26(1)-release\n", stderr: "" };
      }
      if (executable === verifiedPathBash && args.includes("uname -s")) {
        return { exitCode: 0, stdout: "MINGW64_NT-10.0\n", stderr: "" };
      }
      if (executable === gitExecutable && args[0] === "--version") {
        return { exitCode: 0, stdout: "git version 2.46.0.windows.1\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unavailable" };
    },
  };
}

function pluginManager(): OfficialPluginManager {
  const installed = new Set<string>();
  return {
    list: async () => ({
      installed: [...installed].map((pluginId) => ({ pluginId, installed: true, enabled: true })),
      available: [],
    }),
    addMarketplace: async () => undefined,
    add: async (pluginId) => {
      installed.add(pluginId);
    },
    remove: async (pluginId) => {
      installed.delete(pluginId);
    },
  };
}

describe("Windows native-agent instructions", () => {
  test("uses the verified PATH Bash in Root generation, App Server readback, and install verification", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "holycodex-native-windows-"));
    const codexHome = join(temporaryRoot, "codex");
    try {
      const installed = await installHolyCodex(
        { profile: "default" },
        {
          paths: { codexHome },
          runtime: windowsRuntime(),
          officialPluginManager: pluginManager(),
        },
      );
      expect(installed.record.tooling?.git_bash).toMatchObject({
        status: "healthy",
        path: verifiedPathBash,
      });

      const configText = await readFile(join(codexHome, "config.toml"), "utf8");
      const config = parseConfig(configText);
      const rootInstructions = config["developer_instructions"];
      expect(typeof rootInstructions).toBe("string");
      expect(rootInstructions).toContain(windowsGitBashShellDirective(verifiedPathBash));
      expect(rootInstructions).not.toContain(JSON.stringify(WINDOWS_GIT_BASH));

      const transport = new ConfigReadTransport(config);
      const appServer = new AppServerClient(transport);
      await appServer.initialize();
      const readback = await appServer.readConfig();
      expect(readTomlPath(readback.config, "developer_instructions")).toBe(rootInstructions);
      for (const agent of projectNativeAgents("default")) {
        const rolePath = join(codexHome, "holycodex", "agents", `${agent.name}.toml`);
        const roleText = await readFile(rolePath, "utf8");
        expect(roleText).toBe(
          renderNativeAgent(agent, { windowsGitBashExecutable: verifiedPathBash }),
        );
        const roleInstructions = parseConfig(roleText)["developer_instructions"];
        expect(typeof roleInstructions).toBe("string");
        expect(roleInstructions).toContain(windowsGitBashShellDirective(verifiedPathBash));
        expect(roleInstructions).not.toContain(WINDOWS_GIT_BASH);
        expect(readTomlPath(readback.config, `agents."${agent.name}".config_file`)).toBe(
          `holycodex/agents/${agent.name}.toml`,
        );
      }
      await appServer.close();

      expect(
        await inspectNativeAgentConflicts(
          codexHome,
          "default",
          installed.record.managed_artifacts,
          "standard",
          verifiedPathBash,
        ),
      ).toEqual([]);
      const changedRole = join(
        codexHome,
        "holycodex",
        "agents",
        `${projectNativeAgents("default")[0]!.name}.toml`,
      );
      await writeFile(changedRole, `${await readFile(changedRole, "utf8")}# user edit\n`);
      const conflicts = await inspectNativeAgentConflicts(
        codexHome,
        "default",
        installed.record.managed_artifacts,
        "standard",
        verifiedPathBash,
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ path: changedRole, action: "replace" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("uses a shorter Astra Root instruction set while retaining its governing boundaries", () => {
    const highRoot = projectRootAgent("high");
    const lowRoot = projectRootAgent("low");
    const defaultRoot = projectRootAgent("default");
    expect(highRoot).toMatchObject({ model: "gpt-6-astra", effort: "high" });
    expect(lowRoot).toMatchObject({ model: "gpt-6-sol", effort: "medium" });
    expect(defaultRoot).toMatchObject({ model: "gpt-6-sol", effort: "high" });
    const sol = rootDeveloperInstructions({
      frontend: false,
      security: false,
      rootModel: defaultRoot.model,
    });
    const astra = rootDeveloperInstructions({
      frontend: false,
      security: false,
      rootModel: highRoot.model,
    });
    const lowSol = rootDeveloperInstructions({
      frontend: false,
      security: false,
      rootModel: lowRoot.model,
    });
    expect(astra).toMatch(/fork_turns: "none".*never omit.*all.*default/isu);
    expect(sol).toMatch(/fork_turns: "none".*never omit.*all.*default/isu);
    expect(lowSol).toMatch(/fork_turns: "none".*never omit.*all.*default/isu);
    expect(astra.length).toBeLessThan(sol.length / 2);
    expect(astra).toContain("bounded Assignment");
    expect(astra).toContain("exact concrete registered Role.task agent_type");
    expect(astra).toContain("holycodex-agent semantic operations");
    expect(astra).toContain("routine safe, reversible, in-scope choices");
    expect(astra).toContain("Reviewer.code before VCS");
    expect(astra).not.toContain("longest practical event wait");

    for (const instructions of [lowSol, sol, astra]) {
      expect(instructions).toMatch(
        /implementation completes.*Reviewer\.code reaches a fixed point.*Worker\.validation runs.*Root integrates and handles VCS.*Reviewer\.code repair invalidates earlier validation, so rerun Worker\.validation/isu,
      );
    }
  });
});
