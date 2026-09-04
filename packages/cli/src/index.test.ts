// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  assertRootText,
  doctorHolyCodex,
  installHolyCodex,
  installRecordDigest,
  parseArgv,
  pathWithin,
  projectNativeAgents,
  projectRootAgent,
  readActiveInstallRecord,
  removeHolyCodex,
  renderNativeAgent,
  resolveInstallerPaths,
  runBinary,
  runCli,
} from "./index.ts";
import type { OfficialPluginManager } from "./index.ts";

function fakeManager(
  options: Readonly<{
    readonly failAdds?: ReadonlySet<string>;
    readonly missingAdds?: ReadonlySet<string>;
    readonly initial?: Readonly<Record<string, "installed" | "disabled" | "available">>;
    readonly failRemoves?: ReadonlySet<string>;
  }> = {},
) {
  const states = new Map<string, { installed: boolean; enabled: boolean }>();
  for (const [pluginId, status] of Object.entries(options.initial ?? {})) {
    states.set(pluginId, { installed: status !== "available", enabled: status === "installed" });
  }
  const manager: OfficialPluginManager = {
    list: async () => ({
      installed: [...states]
        .filter(([, state]) => state.installed)
        .map(([pluginId, state]) => ({ pluginId, ...state })),
      available: [...states]
        .filter(([, state]) => !state.installed)
        .map(([pluginId, state]) => ({ pluginId, ...state })),
    }),
    addMarketplace: async () => undefined,
    add: async (pluginId) => {
      if (options.failAdds?.has(pluginId)) throw new Error(`${pluginId} unavailable`);
      if (options.missingAdds?.has(pluginId)) return;
      states.set(pluginId, { installed: true, enabled: true });
    },
    remove: async (pluginId) => {
      if (options.failRemoves?.has(pluginId)) throw new Error(`${pluginId} removal failed`);
      states.delete(pluginId);
    },
    status: async (ids) =>
      Object.fromEntries(
        ids.map((id) => {
          const state = states.get(id);
          return [id, state?.installed ? (state.enabled ? "installed" : "disabled") : "missing"];
        }),
      ),
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
    expect(() => assertRootText("/tmp/codex\u0000home", "CODEX_HOME")).toThrow(
      "invalid characters",
    );
    expect(() => assertRootText("/tmp/codex\n", "CODEX_HOME")).toThrow("invalid characters");
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
      expect(install.record.owned_plugins).toEqual([
        "holycodex@holycodex",
        "build-web-apps@openai-curated",
        "codex-security@openai-curated",
      ]);
      expect(install.record.managed_artifacts).toHaveLength(4);
      expect(install.record.status).toBe("active");
      expect(
        await readFile(join(codexHome, "holycodex", "agents", "worker.toml"), "utf8"),
      ).toContain('model_reasoning_summary = "none"');
      const config = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('model = "gpt-5.6-sol"');
      expect(config).toContain("default_mode_request_user_input = true");
      expect(config).toContain("multi_agent_v2 = true");
      expect(config).toContain("experimental_mode = true");
      expect(config).toContain("Before delegation, ensure writing-for-agents is fully loaded");
      expect(config).toContain("fully load it on first use in the active context");
      expect(config).toContain("reuse it while its complete instructions remain available");
      expect(config).toContain("reload only after compaction, a new context");
      expect(config).not.toContain('name = "root"');
      const leaf = await readFile(join(codexHome, "holycodex", "agents", "worker.toml"), "utf8");
      expect(leaf).toContain('service_tier = "default"');
      expect(leaf).toContain('model_verbosity = "low"');
      expect(leaf).toContain("tool_output_token_limit = 12000");
      expect(leaf).toContain("[agents]");
      expect(leaf).toContain("enabled = false");
      expect(leaf).toContain("interrupt_message = false");
      expect(leaf).toContain("[features]");
      expect(leaf).toContain("multi_agent_v2 = false");
      expect(leaf).toContain("multi_agent = false");
      expect(leaf).not.toContain("sandbox_mode");
      expect(leaf).toContain("Execute only the assigned scope");
      expect(leaf).not.toContain("Do not spawn agents, message peers, or delegate work.");
      const result = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(result.preserved).toEqual([]);
      expect(result.removed).toContain("holycodex@holycodex");
      expect(result.removed).toContain("build-web-apps@openai-curated");
      expect(result.removed).toContain("codex-security@openai-curated");
      await expect(manager.list?.()).resolves.toMatchObject({ installed: [] });
      await expect(readFile(join(codexHome, "holycodex", "active.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a default-selected provider is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager({
      missingAdds: new Set(["build-web-apps@openai-curated"]),
      failAdds: new Set(["codex-security@openai-curated"]),
    });
    try {
      await expect(
        installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager }),
      ).rejects.toMatchObject({ code: "capability_denied" });
      await expect(readFile(join(codexHome, "holycodex", "active.json"))).rejects.toThrow();
      await expect(readFile(join(codexHome, "holycodex", "conflicted.json"))).resolves.toBeTruthy();
      await expect(manager.list?.()).resolves.toMatchObject({ installed: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves pre-existing selected providers during removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-provider-preserve-"));
    const codexHome = join(root, "codex");
    const frontend = "build-web-apps@openai-curated";
    const security = "codex-security@openai-curated";
    const manager = fakeManager({
      initial: { [frontend]: "installed", [security]: "installed" },
    });
    try {
      const install = await installHolyCodex(
        {},
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(install.record.owned_plugins).toEqual(["holycodex@holycodex"]);
      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(removed.preserved).toEqual([]);
      expect(removed.removed).not.toContain(frontend);
      expect(removed.removed).not.toContain(security);
      await expect(manager.list?.()).resolves.toMatchObject({
        installed: expect.arrayContaining([
          expect.objectContaining({ pluginId: frontend, installed: true, enabled: true }),
          expect.objectContaining({ pluginId: security, installed: true, enabled: true }),
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes provider effects recorded by a conflicted reinstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-provider-recovery-"));
    const codexHome = join(root, "codex");
    const provider = "build-web-apps@openai-curated";
    const base = fakeManager();
    let providerState: "absent" | "disabled" = "absent";
    let providerRemoveAttempts = 0;
    const manager: OfficialPluginManager = {
      ...base,
      list: async () => {
        const live = await base.list!();
        if (providerState === "disabled") {
          return {
            installed: [...live.installed, { pluginId: provider, installed: true, enabled: false }],
            available: live.available,
          };
        }
        return live;
      },
      add: async (pluginId) => {
        if (pluginId === provider) {
          providerState = "disabled";
          return;
        }
        await base.add!(pluginId);
      },
      remove: async (pluginId) => {
        if (pluginId === provider) {
          providerRemoveAttempts += 1;
          if (providerRemoveAttempts === 1) throw new Error("provider rollback failed");
          providerState = "absent";
          return;
        }
        await base.remove!(pluginId);
      },
    };
    try {
      await installHolyCodex(
        { optional: { frontend: false, security: false } },
        { paths: { codexHome }, officialPluginManager: manager },
      );
      await expect(
        installHolyCodex(
          { optional: { frontend: true, security: false } },
          { paths: { codexHome }, officialPluginManager: manager },
        ),
      ).rejects.toMatchObject({ code: "capability_denied" });
      await expect(readFile(join(codexHome, "holycodex", "conflicted.json"))).resolves.toBeTruthy();

      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(removed.preserved).toEqual([]);
      expect(providerRemoveAttempts).toBe(2);
      await expect(manager.list?.()).resolves.toMatchObject({ installed: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed without changing a disabled pre-existing provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-provider-disabled-"));
    const codexHome = join(root, "codex");
    const provider = "build-web-apps@openai-curated";
    const manager = fakeManager({ initial: { [provider]: "disabled" } });
    try {
      await expect(
        installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager }),
      ).rejects.toMatchObject({ code: "capability_denied" });
      await expect(manager.list?.()).resolves.toMatchObject({
        installed: [
          expect.objectContaining({ pluginId: provider, installed: true, enabled: false }),
        ],
      });
      await expect(readFile(join(codexHome, "holycodex", "active.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bootstraps Codex-owned provider marketplaces before native plugin mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-marketplace-bootstrap-"));
    const codexHome = join(root, "codex");
    const events: string[] = [];
    const base = fakeManager();
    const manager: OfficialPluginManager = {
      ...base,
      ensureOfficialMarketplace: async (selected) => {
        events.push(`bootstrap:${selected.join(",")}`);
      },
      addMarketplace: async (source) => {
        events.push(`marketplace:${source}`);
      },
      add: async (pluginId) => {
        events.push(`add:${pluginId}`);
        await base.add?.(pluginId);
      },
    };
    try {
      await installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager });
      expect(events[0]).toBe(
        "bootstrap:build-web-apps@openai-curated,codex-security@openai-curated",
      );
      expect(events[1]).toBe(`marketplace:${"davidbasilefilho/holycodex"}`);
      expect(events).not.toContain("marketplace:openai-curated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not register a malformed pre-existing HolyCodex role", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-role-conflict-"));
    const codexHome = join(root, "codex");
    const rolePath = join(codexHome, "holycodex", "agents", "worker.toml");
    try {
      await mkdir(join(codexHome, "holycodex", "agents"), { recursive: true });
      await writeFile(rolePath, 'name = "not-worker"\n');
      await expect(
        installHolyCodex({}, { paths: { codexHome }, officialPluginManager: fakeManager() }),
      ).rejects.toMatchObject({ code: "install_failed" });
      await expect(readFile(join(codexHome, "holycodex", "active.json"))).rejects.toThrow();
      expect(await readFile(rolePath, "utf8")).toBe('name = "not-worker"\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a state-less exact 0.16 legacy Root role during install", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-legacy-root-"));
    const codexHome = join(root, "codex");
    const legacyRoot = join(codexHome, "agents", "root.toml");
    try {
      await mkdir(join(codexHome, "agents"), { recursive: true });
      await writeFile(
        legacyRoot,
        [
          'name = "root"',
          'description = "Root-directed HolyCodex control agent."',
          'model = "gpt-5.6-sol"',
          'model_reasoning_effort = "medium"',
          'service_tier = "default"',
          'model_verbosity = "low"',
          "",
        ].join("\n"),
      );
      const install = await installHolyCodex(
        {},
        { paths: { codexHome }, officialPluginManager: fakeManager() },
      );
      expect(install.preserved).not.toContain(legacyRoot);
      await expect(readFile(legacyRoot)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports and removes a state-less exact legacy Root role", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-legacy-remove-"));
    const codexHome = join(root, "codex");
    const legacyRoot = join(codexHome, "agents", "root.toml");
    try {
      await mkdir(join(codexHome, "agents"), { recursive: true });
      await writeFile(
        legacyRoot,
        'name = "root"\ndescription = "Root-directed HolyCodex control agent."\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\nservice_tier = "default"\nmodel_verbosity = "low"\n',
      );
      const doctor = await doctorHolyCodex({
        paths: { codexHome },
        officialPluginManager: fakeManager(),
      });
      expect(doctor.healthy).toBe(false);
      expect(doctor.checks["native_roles"]?.reasons).toContain("stale_legacy_root");
      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: fakeManager(),
      });
      expect(removed.removed).toContain(legacyRoot);
      await expect(readFile(legacyRoot)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves an unrelated user Root role", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-user-root-"));
    const codexHome = join(root, "codex");
    const userRoot = join(codexHome, "agents", "root.toml");
    try {
      await mkdir(join(codexHome, "agents"), { recursive: true });
      const contents =
        'name = "root"\ndescription = "My personal Root role."\nmodel = "gpt-5.6-sol"\n';
      await writeFile(userRoot, contents);
      const manager = fakeManager();
      const install = await installHolyCodex(
        {},
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(install.preserved).toContain(userRoot);
      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(removed.preserved).toContain(userRoot);
      expect(await readFile(userRoot, "utf8")).toBe(contents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires selected providers on every reinstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const failures = new Set(["build-web-apps@openai-curated"]);
    const manager = fakeManager({ failAdds: failures });
    try {
      await expect(
        installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager }),
      ).rejects.toMatchObject({ code: "capability_denied" });
      await expect(readFile(join(codexHome, "holycodex", "conflicted.json"))).resolves.toBeTruthy();
      failures.clear();
      const recoveredRoot = await mkdtemp(join(tmpdir(), "holycodex-cli-recovered-"));
      const recoveredCodexHome = join(recoveredRoot, "codex");
      const recovered = await installHolyCodex(
        { optional: { frontend: false, security: false } },
        { paths: { codexHome: recoveredCodexHome }, officialPluginManager: manager },
      );
      expect(recovered.record.capability_state?.frontend.status).toBe("disabled");
      await rm(recoveredRoot, { recursive: true, force: true });

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
    expect(projectNativeAgents("go")).toHaveLength(11);

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

  test("migrates a validated legacy Go record and recomputes its digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    try {
      const initial = await installHolyCodex(
        { optional: { frontend: false, security: false } },
        { paths: { codexHome }, officialPluginManager: fakeManager() },
      );
      const legacyRecord = {
        owner: initial.record.owner,
        schema_epoch: initial.record.schema_epoch,
        install_id: initial.record.install_id,
        version: initial.record.version,
        plan: "Go" as const,
        tier: initial.record.tier,
        optional_selections: initial.record.optional_selections,
        explicit_optional_selections: initial.record.explicit_optional_selections,
        official_plugins: initial.record.official_plugins,
        capability_state: initial.record.capability_state,
        managed_artifacts: initial.record.managed_artifacts,
        installed_at: initial.record.installed_at,
        digest: "",
      };
      legacyRecord.digest = await installRecordDigest({
        owner: legacyRecord.owner,
        install_id: legacyRecord.install_id,
        version: legacyRecord.version,
        plan: legacyRecord.plan,
        tier: legacyRecord.tier,
        optional_selections: legacyRecord.optional_selections,
        explicit_optional_selections: legacyRecord.explicit_optional_selections,
        official_plugins: legacyRecord.official_plugins ?? [],
        capability_state: legacyRecord.capability_state ?? null,
        managed_artifacts: legacyRecord.managed_artifacts,
      });
      const paths = resolveInstallerPaths({ paths: { codexHome } });
      await writeFile(paths.activeRecord, `${JSON.stringify(legacyRecord)}\n`);

      const migrated = await readActiveInstallRecord(paths);
      expect(migrated?.plan).toBe("go");
      expect(migrated?.digest).toBe(
        await installRecordDigest({
          owner: legacyRecord.owner,
          install_id: legacyRecord.install_id,
          version: legacyRecord.version,
          plan: "go",
          tier: legacyRecord.tier,
          optional_selections: legacyRecord.optional_selections,
          explicit_optional_selections: legacyRecord.explicit_optional_selections,
          official_plugins: legacyRecord.official_plugins ?? [],
          capability_state: legacyRecord.capability_state ?? null,
          managed_artifacts: legacyRecord.managed_artifacts,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("manages context experimental mode across reinstall, doctor, and remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-context-"));
    const codexHome = join(root, "codex");
    const config = join(codexHome, "config.toml");
    const contextKey = "features.context_management.experimental_mode";
    const manager = fakeManager();
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        config,
        '[features.context_management]\nexperimental_mode = false\nunrelated = "keep"\n',
      );
      const initial = await installHolyCodex(
        {},
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(await readFile(config, "utf8")).toContain("experimental_mode = true");
      expect(initial.record.managed_config?.managed[contextKey]?.originalValue).toEqual({
        kind: "boolean",
        value: false,
      });
      expect(initial.record.managed_config?.managed[contextKey]?.lastManagedValue).toEqual({
        kind: "boolean",
        value: true,
      });

      const reinstalled = await installHolyCodex(
        { tier: "fast" },
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(reinstalled.record.managed_config?.managed[contextKey]?.originalValue).toEqual({
        kind: "boolean",
        value: false,
      });
      expect(await readFile(config, "utf8")).toContain("experimental_mode = true");
      expect(
        (
          await doctorHolyCodex({
            paths: { codexHome },
            officialPluginManager: manager,
          })
        ).healthy,
      ).toBe(true);

      await writeFile(
        config,
        (await readFile(config, "utf8")).replace(
          "experimental_mode = true",
          "experimental_mode = false",
        ),
      );
      const drifted = await doctorHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(drifted.healthy).toBe(false);
      expect(drifted.checks["runtime_config"]?.reasons).toContain("changed_holycodex_config");

      const conflict = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(conflict.preserved).toContain(config);
      expect(conflict.reasons).toContain("managed_config_changed");
      await expect(readFile(join(codexHome, "holycodex", "conflicted.json"))).resolves.toBeTruthy();

      await writeFile(
        config,
        (await readFile(config, "utf8")).replace(
          "experimental_mode = false",
          "experimental_mode = true",
        ),
      );
      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(removed.preserved).toEqual([]);
      expect(await readFile(config, "utf8")).toContain("experimental_mode = false");
      expect(await readFile(config, "utf8")).toContain('unrelated = "keep"');
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).not.toContain(
        "experimental_mode = true",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves plugin-managed config across install, reinstall, and remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-plugin-config-"));
    const codexHome = join(root, "codex");
    const config = join(codexHome, "config.toml");
    const baseManager = fakeManager();
    const manager: OfficialPluginManager = {
      ...baseManager,
      add: async (pluginId) => {
        await baseManager.add!(pluginId);
        const current = await readFile(config, "utf8").catch(() => "");
        if (!current.includes('external_plugin = "keep"')) {
          await writeFile(config, `[plugins]\nexternal_plugin = "keep"\n${current}`);
        }
      },
    };
    try {
      const initial = await installHolyCodex(
        { optional: { frontend: false, security: false } },
        { paths: { codexHome }, officialPluginManager: manager },
      );
      let current = await readFile(config, "utf8");
      expect(current).toContain('external_plugin = "keep"');
      expect(current).toContain('model = "gpt-5.6-sol"');

      const reinstalled = await installHolyCodex(
        { tier: "fast-all" },
        { paths: { codexHome }, officialPluginManager: manager },
      );
      current = await readFile(config, "utf8");
      expect(current).toContain('external_plugin = "keep"');
      expect(current).toContain('service_tier = "fast"');
      expect(reinstalled.record.managed_config?.managed["service_tier"]).toBeDefined();
      const active = await readActiveInstallRecord(resolveInstallerPaths({ paths: { codexHome } }));
      expect(active?.managed_config).toEqual(reinstalled.record.managed_config);
      expect(active?.digest).toBe(
        await installRecordDigest({
          owner: reinstalled.record.owner,
          install_id: reinstalled.record.install_id,
          version: reinstalled.record.version,
          plan: reinstalled.record.plan,
          tier: reinstalled.record.tier,
          optional_selections: reinstalled.record.optional_selections,
          explicit_optional_selections: reinstalled.record.explicit_optional_selections,
          official_plugins: reinstalled.record.official_plugins ?? [],
          capability_state: reinstalled.record.capability_state ?? null,
          managed_artifacts: reinstalled.record.managed_artifacts,
          managed_config: reinstalled.record.managed_config,
          plugin_config: reinstalled.record.plugin_config,
          provider_config: reinstalled.record.provider_config,
          plugin_snapshot: reinstalled.record.plugin_snapshot,
          owned_plugins: reinstalled.record.owned_plugins,
        }),
      );
      expect(
        (
          await doctorHolyCodex({
            paths: { codexHome },
            officialPluginManager: manager,
          })
        ).healthy,
      ).toBe(true);

      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(removed.preserved).toEqual([]);
      current = await readFile(config, "utf8");
      expect(current).toContain('external_plugin = "keep"');
      expect(current).not.toContain("service_tier =");
      expect(initial.record.managed_config?.managed["service_tier"]).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes absent-before HolyCodex plugin config after native plugin removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-plugin-absent-"));
    const codexHome = join(root, "codex");
    const config = join(codexHome, "config.toml");
    const baseManager = fakeManager();
    const manager: OfficialPluginManager = {
      ...baseManager,
      add: async (pluginId) => {
        await baseManager.add!(pluginId);
        const current = await readFile(config, "utf8");
        if (!current.includes('[plugins."holycodex@holycodex"]')) {
          await writeFile(
            config,
            `${current}\n[plugins."holycodex@holycodex"]\nenabled = true\n\n[marketplaces.holycodex]\nsource_type = "git"\nsource = "https://github.com/davidbasilefilho/holycodex.git"\n`,
          );
        }
      },
    };
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(config, 'unrelated = "keep"\n');
      const install = await installHolyCodex(
        { optional: { frontend: false, security: false } },
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(install.record.plugin_config?.before.preference.presence).toBe("absent");
      expect(install.record.plugin_config?.before.marketplace.presence).toBe("absent");
      expect(install.record.plugin_config?.after.preference.presence).toBe("present");
      expect(install.record.plugin_config?.after.marketplace.presence).toBe("present");

      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(removed.preserved).toEqual([]);
      const cleaned = await readFile(config, "utf8");
      expect(cleaned).toContain('unrelated = "keep"');
      expect(cleaned).not.toContain('[plugins."holycodex@holycodex"]');
      expect(cleaned).not.toContain("[marketplaces.holycodex]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans up or restores only the managed HolyCodex plugin config", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-plugin-state-"));
    const codexHome = join(root, "codex");
    const config = join(codexHome, "config.toml");
    const baseManager = fakeManager();
    const manager: OfficialPluginManager = {
      ...baseManager,
      add: async (pluginId) => {
        await baseManager.add!(pluginId);
        const current = await readFile(config, "utf8");
        await writeFile(config, current.replace("enabled = false", "enabled = true"));
      },
    };
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        config,
        '[plugins."holycodex@holycodex"]\nenabled = false\n\n[marketplaces.holycodex]\nsource_type = "git"\nsource = "https://github.com/davidbasilefilho/holycodex.git"\n',
      );
      const install = await installHolyCodex(
        { optional: { frontend: false, security: false } },
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(install.record.plugin_config?.before.preference.safe_value).toEqual({
        kind: "boolean",
        value: false,
      });
      expect(install.record.plugin_config?.after.preference.safe_value).toEqual({
        kind: "boolean",
        value: true,
      });

      await writeFile(
        config,
        (await readFile(config, "utf8")).replace("enabled = true", "enabled = false"),
      );
      const conflict = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(conflict.preserved).toContain(config);
      expect(conflict.reasons).toContain("plugin_config_changed");
      await expect(readFile(join(codexHome, "holycodex", "conflicted.json"))).resolves.toBeTruthy();

      await writeFile(
        config,
        (await readFile(config, "utf8")).replace("enabled = false", "enabled = true"),
      );
      const removed = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(removed.preserved).toEqual([]);
      const restored = await readFile(config, "utf8");
      expect(restored).toContain("enabled = false");
      expect(restored).toContain("[marketplaces.holycodex]");
      expect(restored).toContain('source = "https://github.com/davidbasilefilho/holycodex.git"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflights malformed role files before creating partial roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-role-preflight-"));
    const codexHome = join(root, "codex");
    const roleRoot = join(codexHome, "holycodex", "agents");
    const malformedWorker = join(roleRoot, "worker.toml");
    try {
      await mkdir(roleRoot, { recursive: true });
      await writeFile(malformedWorker, "not valid HolyCodex role data\n");
      await expect(
        installHolyCodex(
          { optional: { frontend: false, security: false } },
          { paths: { codexHome }, officialPluginManager: fakeManager() },
        ),
      ).rejects.toMatchObject({ code: "install_failed" });
      expect(await readFile(malformedWorker, "utf8")).toBe("not valid HolyCodex role data\n");
      for (const role of ["explorer", "librarian", "reviewer"] as const) {
        await expect(readFile(join(roleRoot, `${role}.toml`), "utf8")).rejects.toThrow();
      }
      await expect(readFile(join(codexHome, "holycodex", "active.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves edited managed files during reinstall and remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const codexHome = join(root, "codex");
    const manager = fakeManager();
    const leaf = join(codexHome, "holycodex", "agents", "worker.toml");
    const config = join(codexHome, "config.toml");
    try {
      await installHolyCodex({}, { paths: { codexHome }, officialPluginManager: manager });
      await writeFile(leaf, "user edit\n");
      const managedConfig = await readFile(config, "utf8");
      await writeFile(config, `approval_policy = "on-request"\n${managedConfig}`);
      const reinstall = await installHolyCodex(
        { tier: "fast-all" },
        { paths: { codexHome }, officialPluginManager: manager },
      );
      expect(reinstall.preserved).toContain(leaf);
      expect(reinstall.preserved).not.toContain(config);
      expect(reinstall.warnings).toEqual(["modified managed files were preserved"]);
      expect(await readFile(leaf, "utf8")).toBe("user edit\n");
      expect(await readFile(config, "utf8")).toContain('approval_policy = "on-request"');
      expect(await readFile(config, "utf8")).toContain('service_tier = "fast"');

      const result = await removeHolyCodex({
        paths: { codexHome },
        officialPluginManager: manager,
      });
      expect(result.preserved).toContain(leaf);
      expect(result.preserved).not.toContain(config);
      expect(result.reasons).toContain("managed_artifact_changed");
      expect(await readFile(leaf, "utf8")).toBe("user edit\n");
      expect(await readFile(config, "utf8")).toContain('approval_policy = "on-request"');
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
      expect(changed.reasons).toContain("state_corrupt");
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
