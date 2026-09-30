// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

test("Root visual fallback includes only selected capabilities in priority order", () => {
  for (const browserUse of [false, true]) {
    for (const computerUse of [false, true]) {
      const instruction = rootDeveloperInstructions({ browserUse, computerUse })
        .split("\n")
        .find((line) => line.startsWith("For Root visual judgment,"))!;
      expect(instruction.includes("in-app browser (IAB)")).toBe(browserUse);
      expect(instruction.includes("Computer Use")).toBe(computerUse);
      expect(instruction).toContain("other available rendered evidence");
      if (browserUse && computerUse) {
        expect(instruction.indexOf("IAB")).toBeLessThan(instruction.indexOf("Computer Use"));
      }
    }
  }
});
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";

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
  type InstallerRuntime,
  type OfficialPluginManager,
} from "./index.ts";
import { parseConfig } from "./installer.ts";
import {
  installNativeAgents,
  inspectNativeAgentConflicts,
  nativeAgentConfigPath,
  nativeAgentGenerationId,
  nativeAgentSandboxConfigurationMatches,
  nativeAgentSandboxMode,
  rollbackNativeAgentInstall,
} from "./native-agents.ts";

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
      if (args.join(" ") === "pm view ctx7 version") {
        return { exitCode: 0, stdout: "2.0.0\n", stderr: "" };
      }
      if (executable === processPath && args.join(" ") === "add -g ctx7@latest") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (executable === shim && args[0] === "--version") {
        return { exitCode: 0, stdout: "ctx7 2.0.0\n", stderr: "" };
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
  test("publishes a complete native-agent generation before switching registrations", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "holycodex-agent-generation-"));
    const codexHome = join(temporaryRoot, "codex");
    const manager = pluginManager();
    const runtime: InstallerRuntime = { ...windowsRuntime(), platform: "linux" };
    try {
      const initial = await installHolyCodex(
        { profile: "default" },
        { paths: { codexHome }, runtime, officialPluginManager: manager },
      );
      const initialConfig = parseConfig(await readFile(join(codexHome, "config.toml"), "utf8"));
      const previousRefs = new Map(
        projectNativeAgents("default").map((agent) => [
          agent.name,
          readTomlPath(initialConfig, `agents."${agent.name}".config_file`),
        ]),
      );
      const previousContents = new Map<string, string>();
      for (const [name, ref] of previousRefs) {
        if (typeof ref !== "string") throw new Error(`Missing initial registration for ${name}.`);
        previousContents.set(name, await readFile(join(codexHome, ...ref.split("/")), "utf8"));
      }

      let configAtRolePublication: ReturnType<typeof parseConfig> | undefined;
      const upgraded = await installHolyCodex(
        { profile: "low" },
        {
          paths: { codexHome },
          runtime,
          officialPluginManager: manager,
          onProgress: (event) => {
            if (event.stage === "roles" && event.status === "completed") {
              configAtRolePublication = parseConfig(
                readFileSync(join(codexHome, "config.toml"), "utf8"),
              );
            }
            if (event.stage === "config" && event.status === "completed") {
              const published = parseConfig(readFileSync(join(codexHome, "config.toml"), "utf8"));
              const expectedGeneration = nativeAgentGenerationId("low", "standard", {
                browserUse: true,
                computerUse: false,
              });
              expect(readTomlPath(published, 'agents."Explorer.map".config_file')).toBe(
                nativeAgentConfigPath("Explorer.map", expectedGeneration),
              );
            }
          },
        },
      );
      expect(configAtRolePublication).toBeDefined();
      for (const [name, ref] of previousRefs) {
        expect(readTomlPath(configAtRolePublication!, `agents."${name}".config_file`)).toBe(ref);
      }

      const finalConfig = parseConfig(await readFile(join(codexHome, "config.toml"), "utf8"));
      const nextGeneration = nativeAgentGenerationId("low", "standard", {
        browserUse: upgraded.record.optional_selections.browser_use,
        computerUse: upgraded.record.optional_selections.computer_use,
      });
      for (const agent of projectNativeAgents("low")) {
        const expectedRef = nativeAgentConfigPath(agent.name, nextGeneration);
        expect(readTomlPath(finalConfig, `agents."${agent.name}".config_file`)).toBe(expectedRef);
        const newText = await readFile(join(codexHome, ...expectedRef.split("/")), "utf8");
        expect(newText).toBe(
          renderNativeAgent(agent, {
            browserUse: upgraded.record.optional_selections.browser_use,
            computerUse: upgraded.record.optional_selections.computer_use,
          }),
        );
        const oldRef = previousRefs.get(agent.name);
        if (typeof oldRef !== "string")
          throw new Error(`Missing initial registration for ${agent.name}.`);
        const oldText = previousContents.get(agent.name);
        if (oldText === undefined)
          throw new Error(`Missing initial role content for ${agent.name}.`);
        expect(await readFile(join(codexHome, ...oldRef.split("/")), "utf8")).toBe(oldText);
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps shell selection with Codex through Root generation and App Server readback", async () => {
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
      expect(installed.record.tooling).not.toHaveProperty("git_bash");

      const configText = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(configText).not.toContain("thread_tools");
      expect(configText).not.toContain("holycodex-readonly-network");
      const config = parseConfig(configText);
      const rootInstructions = config["developer_instructions"];
      expect(typeof rootInstructions).toBe("string");
      expect(rootInstructions).not.toContain("set the shell parameter to exactly");
      expect(rootInstructions).not.toContain("Git for Windows Bash environment");

      const transport = new ConfigReadTransport(config);
      const appServer = new AppServerClient(transport);
      await appServer.initialize();
      const readback = await appServer.readConfig();
      expect(readTomlPath(readback.config, "developer_instructions")).toBe(rootInstructions);
      expect(readTomlPath(readback.config, "features.default_mode_request_user_input")).toBe(true);
      expect(readTomlPath(readback.config, "features.multi_agent")).toBe(true);
      expect(readTomlPath(readback.config, "features.multi_agent_v2")).toBe(false);
      expect(readTomlPath(readback.config, "features.agent_message_board")).toBe(false);
      expect(readTomlPath(readback.config, "features.context_management.experimental_mode")).toBe(
        true,
      );
      const instructionOptions = {
        browserUse: installed.record.optional_selections.browser_use,
        computerUse: installed.record.optional_selections.computer_use,
      };
      const generationId = nativeAgentGenerationId("default", "standard", instructionOptions);
      for (const agent of projectNativeAgents("default")) {
        const roleRef = nativeAgentConfigPath(agent.name, generationId);
        const rolePath = join(codexHome, ...roleRef.split("/"));
        const roleText = await readFile(rolePath, "utf8");
        expect(roleText).toBe(renderNativeAgent(agent, instructionOptions));
        expect(roleText).toContain(`sandbox_mode = "${nativeAgentSandboxMode(agent)}"`);
        expect(nativeAgentSandboxConfigurationMatches(agent, parseConfig(roleText))).toBe(true);
        if (nativeAgentSandboxMode(agent) === "workspace-write") {
          expect(roleText).toContain("network_access = true");
        } else {
          expect(roleText).not.toContain("[sandbox_workspace_write]");
        }
        expect(roleText).not.toContain("default_permissions =");
        expect(roleText).not.toContain("[permissions.");
        expect(roleText).not.toContain("thread_tools");
        const roleDocument = parseConfig(roleText);
        expect(readTomlPath(roleDocument, "features.multi_agent")).toBe(false);
        expect(readTomlPath(roleDocument, "features.multi_agent_v2")).toBe(false);
        expect(readTomlPath(roleDocument, "features.agent_message_board")).toBe(false);
        expect(readTomlPath(roleDocument, "features.context_management.experimental_mode")).toBe(
          true,
        );
        const roleInstructions = parseConfig(roleText)["developer_instructions"];
        expect(typeof roleInstructions).toBe("string");
        expect(roleInstructions).toMatch(
          /Read-only Git\/VCS, CI, and PR-comment inspection is allowed when relevant and within the Assignment; Git\/VCS writes remain Root-only/iu,
        );
        expect(roleInstructions).not.toContain("set the shell parameter to exactly");
        expect(roleInstructions).not.toContain("Git for Windows Bash environment");
        expect(readTomlPath(readback.config, `agents."${agent.name}".config_file`)).toBe(roleRef);
      }
      await appServer.close();

      expect(
        await inspectNativeAgentConflicts(
          codexHome,
          "default",
          installed.record.managed_artifacts,
          "standard",
          {
            browserUse: installed.record.optional_selections.browser_use,
            computerUse: installed.record.optional_selections.computer_use,
          },
        ),
      ).toEqual([]);
      const changedRole = join(
        codexHome,
        ...nativeAgentConfigPath(projectNativeAgents("default")[0]!.name, generationId).split("/"),
      );
      await writeFile(changedRole, `${await readFile(changedRole, "utf8")}# user edit\n`);
      const conflicts = await inspectNativeAgentConflicts(
        codexHome,
        "default",
        installed.record.managed_artifacts,
        "standard",
        {
          browserUse: installed.record.optional_selections.browser_use,
          computerUse: installed.record.optional_selections.computer_use,
        },
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ path: changedRole, action: "replace" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("warns before replacing an unrecorded generated role file and supports cancellation", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "holycodex-native-role-conflict-"));
    const codexHome = join(temporaryRoot, "codex");
    const agent = projectNativeAgents("default")[0];
    if (agent === undefined) throw new Error("The default profile has no native agents.");
    const rolePath = join(
      codexHome,
      ...nativeAgentConfigPath(agent.name, nativeAgentGenerationId("default")).split("/"),
    );
    const foreignContents = "user-owned role contents\n";
    try {
      await mkdir(dirname(rolePath), { recursive: true });
      await writeFile(rolePath, foreignContents);

      const conflicts = await inspectNativeAgentConflicts(codexHome, "default");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        path: rolePath,
        action: "replace",
        defaultDecision: "replace",
        validDecisions: ["replace", "cancel"],
        existing: { present: true },
        desired: { present: true },
      });

      const cancelledInstall = installNativeAgents(
        codexHome,
        "default",
        [],
        "standard",
        async () => "cancel",
      );
      await expect(cancelledInstall).rejects.toThrow(
        "Native-agent conflict resolution was cancelled",
      );
      expect(await readFile(rolePath, "utf8")).toBe(foreignContents);

      const installed = await installNativeAgents(
        codexHome,
        "default",
        [],
        "standard",
        async (conflict) => {
          expect(conflict.path).toBe(rolePath);
          return "accept";
        },
      );
      expect(await readFile(rolePath, "utf8")).toBe(renderNativeAgent(agent));
      expect(installed.rollback.find(({ path }) => path === rolePath)).toMatchObject({
        path: rolePath,
        previous: foreignContents,
      });
      await rollbackNativeAgentInstall(installed.rollback);
      expect(await readFile(rolePath, "utf8")).toBe(foreignContents);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("switches Windows profile registrations to the matching native generation", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "holycodex-native-windows-profile-"));
    const codexHome = join(temporaryRoot, "codex");
    try {
      const runtime = windowsRuntime();
      const manager = pluginManager();
      await installHolyCodex(
        { profile: "default" },
        { paths: { codexHome }, runtime, officialPluginManager: manager },
      );
      const upgraded = await installHolyCodex(
        { profile: "low" },
        { paths: { codexHome }, runtime, officialPluginManager: manager },
      );
      const config = parseConfig(await readFile(join(codexHome, "config.toml"), "utf8"));
      const generation = nativeAgentGenerationId("low", "standard", {
        browserUse: upgraded.record.optional_selections.browser_use,
        computerUse: upgraded.record.optional_selections.computer_use,
      });
      for (const agent of projectNativeAgents("low")) {
        expect(readTomlPath(config, `agents."${agent.name}".config_file`)).toBe(
          nativeAgentConfigPath(agent.name, generation),
        );
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("migrates owned legacy network profiles while preserving user configuration", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "holycodex-agent-network-migration-"));
    const codexHome = join(temporaryRoot, "codex");
    const legacyRolePath = join(codexHome, "holycodex", "agents", "Explorer.lookup.toml");
    const configPath = join(codexHome, "config.toml");
    const userConfig = '[permissions."holycodex-readonly-network"]\ncustom = true\n';
    try {
      const agent = projectNativeAgents("default").find(({ name }) => name === "Explorer.lookup");
      if (agent === undefined) throw new Error("Explorer.lookup route is missing.");
      const current = renderNativeAgent(agent);
      const legacy = current
        .replace(
          'sandbox_mode = "workspace-write"',
          'default_permissions = "holycodex-readonly-network"',
        )
        .replace(
          "[sandbox_workspace_write]\nnetwork_access = true",
          '[permissions."holycodex-readonly-network"]\nextends = ":read-only"\n\n[permissions."holycodex-readonly-network".network]\nenabled = true',
        );
      await mkdir(join(codexHome, "holycodex", "agents"), { recursive: true });
      await writeFile(legacyRolePath, legacy);
      await writeFile(configPath, userConfig);

      await installNativeAgents(codexHome, "default", [
        {
          path: "holycodex/agents/Explorer.lookup.toml",
          digest: createHash("sha256").update(legacy).digest("hex"),
        },
      ]);

      const currentPath = join(
        codexHome,
        ...nativeAgentConfigPath("Explorer.lookup", nativeAgentGenerationId("default")).split("/"),
      );
      expect(await readFile(currentPath, "utf8")).toBe(current);
      expect(await readFile(legacyRolePath, "utf8")).toBe(legacy);
      expect(await readFile(configPath, "utf8")).toBe(userConfig);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("retains Root profile routing and governing boundaries", () => {
    const highRoot = projectRootAgent("high");
    const lowRoot = projectRootAgent("low");
    const defaultRoot = projectRootAgent("default");
    expect(highRoot).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    expect(lowRoot).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });
    expect(defaultRoot).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    const sol = rootDeveloperInstructions({
      frontend: false,
      security: false,
      rootModel: defaultRoot.model,
    });
    const high = rootDeveloperInstructions({
      frontend: false,
      security: false,
      rootModel: highRoot.model,
    });
    const lowSol = rootDeveloperInstructions({
      frontend: false,
      security: false,
      rootModel: lowRoot.model,
    });
    for (const instructions of [lowSol, sol, high]) {
      expect(instructions).not.toContain("set the shell parameter to exactly");
      expect(instructions).toContain('fork_turns: "none"');
      expect(instructions).toContain("Never perform delegable work yourself");
      expect(instructions).toContain("bounded Assignment");
      expect(instructions).toContain("registered Role.task configuration");
      expect(instructions).toContain("Verify the registration once per configuration generation");
      expect(instructions).toContain("holycodex-agent semantic operations");
      expect(instructions).toContain("Do not edit TOON state");
      expect(instructions).toContain("Reviewer.code fixed point");
      expect(instructions).toContain("Worker.validation");
      expect(instructions).toContain("collaboration.wait_agent");
      expect(instructions).toContain("Check existing authorization before asking again");
      expect(instructions).toContain(
        "Before each specialist spawn, persist the bounded Assignment",
      );
      expect(instructions).toContain("Root uses visual-loop");
      expect(instructions).toContain("grill-me, which must ask through request_user_input");
      expect(instructions).toContain("needs_root_input and never ask the user");
      expect(instructions).toContain("Treat later user steering as current");
      expect(instructions).toContain("collaboration.wait_agent at timeout_ms=600000");
      expect(instructions).toContain(
        "Give each overlapping write or shared-mutable seam one specialist owner",
      );
      expect(instructions).toContain("use dev-server");
      expect(instructions).toContain("Reuse worker proof");
      expect(instructions).toContain("across workflow phases");
      expect(instructions).toContain("user explicitly requests direct execution");
      expect(instructions).toContain(
        "complete only when holycodex-agent confirms every completion predicate",
      );
    }
    expect(high).toBe(sol);

    const leaf = renderNativeAgent(projectNativeAgents("default")[0]!);
    const leafInstructions = readTomlPath(parseConfig(leaf), "developer_instructions");
    expect(typeof leafInstructions).toBe("string");
    expect(leafInstructions).not.toContain("set the shell parameter to exactly");
    expect(leaf).toContain("Do not message Root or peers during execution");
    expect(leaf).toContain("Return only one compact, evidence-first terminal outcome");
    expect(leaf).toContain("Do not recover an Assignment");
    expect(leaf).toContain("mutate another Assignment's lifecycle");
    expect(leaf).toContain("never ask the user");
    expect(leaf).toContain("visually judge the current render");
    expect(leaf).toContain("supplements Root's higher-level visual acceptance");
  });
});
