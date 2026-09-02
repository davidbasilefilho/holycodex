// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  assertRootText,
  doctorHolyCodex,
  installHolyCodex,
  parseArgv,
  pathWithin,
  projectNativeAgents,
  projectRootAgent,
  removeHolyCodex,
  renderNativeAgent,
  runBinary,
  runCli,
} from "./index.ts";
import type { OfficialPluginManager } from "./index.ts";

function fakeManager(
  options: Readonly<{
    readonly failAdds?: ReadonlySet<string>;
    readonly missingAdds?: ReadonlySet<string>;
  }> = {},
) {
  const installed = new Set<string>();
  const manager: OfficialPluginManager = {
    list: async () => ({
      installed: [...installed].map((pluginId) => ({ pluginId, installed: true, enabled: true })),
      available: [],
    }),
    addMarketplace: async () => undefined,
    add: async (pluginId) => {
      if (options.failAdds?.has(pluginId)) throw new Error(`${pluginId} unavailable`);
      if (options.missingAdds?.has(pluginId)) return;
      installed.add(pluginId);
    },
    remove: async (pluginId) => {
      installed.delete(pluginId);
    },
    status: async (ids) =>
      Object.fromEntries(ids.map((id) => [id, installed.has(id) ? "installed" : "missing"])),
  };
  return manager;
}

describe("CLI boundaries", () => {
  test("accepts only the current command and option surface", () => {
    expect(parseArgv(["install", "--tier", "standard", "--frontend"]).options["tier"]).toBe(
      "standard",
    );
    expect(parseArgv(["install", "--tier", "fast-all"]).options["tier"]).toBe("fast-all");
    expect(
      parseArgv(["install", "--add-plugin", "a", "--add-plugin", "b"]).options["add-plugin"],
    ).toEqual(["a", "b"]);
    expect(() => parseArgv(["install", "--tier", "Standard"])).toThrow();
    expect(() => parseArgv(["old-command"])).toThrow();
    expect(() => parseArgv(["install", "--legacy-tier"])).toThrow();
    expect(() => parseArgv(["install", "--legacy-frontend"])).toThrow();
  });

  test("uses one JSON envelope and requires yes for noninteractive mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    try {
      const result = await runCli(["remove", "--json", "--codex-home", root], {
        io: { stdoutIsTTY: false, stderrIsTTY: false },
        installer: { officialPluginManager: fakeManager() },
      });
      expect(result.exitCode).toBe(1);
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: "non_tty_confirmation_required" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports missing Codex as a capability denial before installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    try {
      const result = await runCli(["install", "--yes", "--json", "--codex-home", root], {
        env: { PATH: "" },
        io: { stdoutIsTTY: false, stderrIsTTY: false },
      });
      expect(result.exitCode).toBe(2);
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: "capability_denied" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes Windows paths without traversal", () => {
    const root = assertRootText("/c/Users/codex/.codex", "CODEX_HOME", "win32");
    expect(root).toBe("C:\\Users\\codex\\.codex");
    expect(pathWithin(root, "C:\\Users\\codex\\.codex\\agents", "win32")).toBe(true);
    expect(pathWithin(root, "C:\\Users\\other", "win32")).toBe(false);
  });
});

describe("native installation and removal", () => {
  test("persists defaults, native agent ownership, and removes only HolyCodex state", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    try {
      const install = await installHolyCodex(
        {},
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(install.record.plan).toBe("plus");
      expect(install.record.tier).toBe("standard");
      expect(install.record.optional_selections).toMatchObject({
        work: false,
        frontend: true,
        security: true,
      });
      expect(install.record.managed_artifacts.length).toBeGreaterThan(1);
      expect(
        await readFile(join(codexHome, "agents", "Worker.implementation.toml"), "utf8"),
      ).toContain('model_reasoning_summary = "none"');
      const leaf = await readFile(join(codexHome, "agents", "Worker.implementation.toml"), "utf8");
      expect(leaf).toContain('service_tier = "default"');
      expect(leaf).toContain('model_verbosity = "low"');
      expect(leaf).toContain("tool_output_token_limit = 12000");
      expect(leaf).toContain("[agents]");
      expect(leaf).toContain("enabled = false");
      expect(leaf).toContain("interrupt_message = false");
      expect(leaf).toContain("[features]");
      expect(leaf).toContain("multi_agent = false");
      expect(leaf).not.toContain("sandbox_mode");
      expect(leaf).toContain("Report only to Root.");
      expect(leaf).toContain("Do not spawn agents, message peers, or delegate work.");
      const result = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(result.preserved).toEqual([]);
      expect(result.removed).toContain("holycodex@holycodex");
      await expect(readFile(join(codexHome, "holycodex", "active.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("completes an install when implicit default providers are unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager({
      missingAdds: new Set(["build-web-apps@openai-curated"]),
      failAdds: new Set(["codex-security@openai-curated"]),
    });
    try {
      const install = await installHolyCodex(
        {},
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(install.record.optional_selections.frontend).toBe(true);
      expect(install.record.optional_selections.security).toBe(true);
      expect(install.record.capability_state).toMatchObject({
        frontend: { selected: true, status: "missing" },
        security: { selected: true, status: "uncertain" },
      });
      expect(install.warnings).toEqual([
        "optional capability frontend unavailable; skipped plugin build-web-apps@openai-curated (missing)",
        "optional capability security unavailable; skipped plugin codex-security@openai-curated (uncertain)",
      ]);
      const result = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(result.preserved).toEqual([]);
      expect(result.removed).toContain("holycodex@holycodex");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps unavailable defaults recoverable on reinstall but rejects explicit requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const failures = new Set(["build-web-apps@openai-curated"]);
    const manager = fakeManager({ failAdds: failures });
    try {
      const initial = await installHolyCodex(
        {},
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(initial.record.explicit_optional_selections).toEqual({});
      failures.clear();
      const recovered = await installHolyCodex(
        {},
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(recovered.record.capability_state?.frontend.status).toBe("healthy");

      const explicitRoot = await mkdtemp(join(tmpdir(), "holycodex-cli-explicit-"));
      try {
        const explicitManager = fakeManager({
          failAdds: new Set(["build-web-apps@openai-curated"]),
        });
        await expect(
          installHolyCodex(
            { optional: { frontend: true } },
            {
              paths: { codexHome: join(explicitRoot, "codex") },
              officialPluginManager: explicitManager,
            },
          ),
        ).rejects.toMatchObject({ code: "capability_denied" });
      } finally {
        await rm(explicitRoot, { recursive: true, force: true });
      }

      const additionalRoot = await mkdtemp(join(tmpdir(), "holycodex-cli-additional-"));
      try {
        const additionalManager = fakeManager({ failAdds: new Set(["sample@openai-curated"]) });
        await expect(
          installHolyCodex(
            { officialPlugins: ["sample@openai-curated"] },
            {
              paths: { codexHome: join(additionalRoot, "codex") },
              officialPluginManager: additionalManager,
            },
          ),
        ).rejects.toMatchObject({ code: "capability_denied" });
      } finally {
        await rm(additionalRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not swallow an unrelated native list failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    let listCalls = 0;
    const manager: OfficialPluginManager = {
      list: async () => {
        listCalls += 1;
        if (listCalls >= 3) throw new Error("native list backend failed");
        return {
          installed: [{ pluginId: "holycodex@holycodex", installed: true, enabled: true }],
          available: [],
        };
      },
      addMarketplace: async () => undefined,
      add: async () => undefined,
      remove: async () => undefined,
    };
    try {
      await expect(
        installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager }),
      ).rejects.toMatchObject({ code: "capability_denied" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves an additional provider plugin across reinstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const provider = "build-web-apps@openai-curated";
    try {
      const initial = await installHolyCodex(
        { optional: { frontend: false, security: false }, officialPlugins: [provider] },
        { paths: { codexHome }, officialPluginManager: fakeManager() },
      );
      expect(initial.record.official_plugins).toEqual([provider]);

      await expect(
        installHolyCodex(
          {},
          {
            paths: { codexHome },
            officialPluginManager: fakeManager({ failAdds: new Set([provider]) }),
          },
        ),
      ).rejects.toMatchObject({ code: "capability_denied" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("projects service tiers independently of the selected plan", () => {
    expect(projectNativeAgents("Go")).toHaveLength(11);

    const standardRoot = projectRootAgent("plus", "standard");
    const standardLeaf = renderNativeAgent(projectNativeAgents("plus", "standard")[0]!);
    expect(standardRoot.serviceTier).toBe("default");
    expect(standardLeaf).toContain('service_tier = "default"');

    const fastRoot = projectRootAgent("plus", "fast");
    const fastLeaf = renderNativeAgent(projectNativeAgents("plus", "fast")[0]!);
    expect(fastRoot.serviceTier).toBe("default");
    expect(fastLeaf).toContain('service_tier = "fast"');

    const fastAllRoot = projectRootAgent("plus", "fast-all");
    const fastAllLeaf = renderNativeAgent(projectNativeAgents("plus", "fast-all")[0]!);
    expect(fastAllRoot.serviceTier).toBe("fast");
    expect(fastAllLeaf).toContain('service_tier = "fast"');
  });

  test("preserves edited managed files during reinstall and remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    const leaf = join(codexHome, "agents", "Worker.implementation.toml");
    const config = join(codexHome, "config.toml");
    try {
      await installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager });
      await writeFile(leaf, "user edit\n");
      await writeFile(config, "user config\n");
      const reinstall = await installHolyCodex(
        { tier: "fast-all" },
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(reinstall.preserved).toContain(leaf);
      expect(reinstall.preserved).not.toContain(config);
      expect(reinstall.warnings).toEqual(["modified managed files were preserved"]);
      expect(await readFile(leaf, "utf8")).toBe("user edit\n");
      expect(await readFile(config, "utf8")).toBe("user config\n");
      expect(await readFile(join(codexHome, "agents", "root.toml"), "utf8")).toContain(
        'service_tier = "fast"',
      );

      const result = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(result.preserved).toContain(leaf);
      expect(result.preserved).not.toContain(config);
      expect(result.reasons).toContain("managed_artifact_changed");
      expect(await readFile(leaf, "utf8")).toBe("user edit\n");
      expect(await readFile(config, "utf8")).toBe("user config\n");
      await expect(readFile(join(codexHome, "agents", "root.toml"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to replace a changed install record before native effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    try {
      await installHolyCodex({}, { paths: { codexHome }, officialPluginManager: fakeManager() });
      const activePath = join(codexHome, "holycodex", "active.json");
      const record = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
      record["plan"] = "Go";
      await writeFile(activePath, `${JSON.stringify(record)}\n`);
      const manager = {
        ...fakeManager(),
        addMarketplace: async () => {
          throw new Error("unexpected native effect");
        },
      };
      await expect(
        installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager }),
      ).rejects.toMatchObject({ code: "state_corrupt" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves unrelated state beneath the managed directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    try {
      await installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager });
      const unrelated = join(codexHome, "holycodex", "user-notes.txt");
      await writeFile(unrelated, "keep\n");
      const result = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(result.preserved).toContain(join(codexHome, "holycodex"));
      expect(result.reasons).toContain("state_directory_not_empty");
      expect(await readFile(unrelated, "utf8")).toBe("keep\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor reports native plugin status without mutating configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    try {
      await installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager });
      const doctor = await doctorHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(doctor.healthy).toBe(true);
      const activePath = join(codexHome, "holycodex", "active.json");
      const record = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
      record["plan"] = "Go";
      await writeFile(activePath, `${JSON.stringify(record)}\n`);
      const changed = await doctorHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(changed.healthy).toBe(false);
      expect(changed.reasons).toContain("configuration_changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renders help and version in human mode", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runBinary(["install", "--help"], {
      stdoutIsTTY: false,
      stderrIsTTY: false,
      writeStdout: (value) => {
        stdout += value;
      },
      writeStderr: (value) => {
        stderr += value;
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--frontend");
    expect(stdout).toContain("Default plan: plus");
    expect(stderr).toBe("");
  });
});
