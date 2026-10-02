// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import * as Schema from "effect/Schema";

import { OfficialPluginIdSchema } from "./official-plugins";
import {
  LEGACY_ROOT_CONFIG_KEY_PATHS,
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  createManagedRuntimeConfigState,
  isManagedRuntimeConfigState,
  isManagedConfigKeyPath,
  mergeManagedRuntimeConfig,
  normalizeRelativeConfigPath,
  readTomlPath,
  resolveAgentConfigPath,
  summarizeManagedConfigValue,
  writeTomlPath,
} from "./runtime-config";

const metadata = { schema: "state-0.16", installId: "install-1" } as const;

describe("typed runtime configuration", () => {
  test("merges managed dotted keys while retaining unrelated TOML tables", async () => {
    const document = {
      model: "gpt-6.1-sol",
      unrelated: "preserve",
      features: { unrelated_feature: true },
    } as const;
    const merged = await mergeManagedRuntimeConfig(
      document,
      createManagedRuntimeConfigState(metadata),
      {
        model: "gpt-6-luna",
        "features.context_management.experimental_mode": true,
      },
      metadata,
    );

    expect(merged.document).toEqual({
      model: "gpt-6-luna",
      unrelated: "preserve",
      features: { unrelated_feature: true, context_management: { experimental_mode: true } },
    });
    expect(merged.state.managed["model"]?.originalValue).toEqual({
      kind: "enum",
      value: "gpt-6.1-sol",
    });
    expect(
      merged.state.managed["features.context_management.experimental_mode"]?.originalValue,
    ).toEqual({ kind: "absent" });
  });

  test("reports per-key drift and preserves the changed value", async () => {
    const initial = await mergeManagedRuntimeConfig(
      {},
      createManagedRuntimeConfigState(metadata),
      { service_tier: "fast", suppress_unstable_features_warning: true },
      metadata,
    );
    const edited = {
      ...initial.document,
      service_tier: "default",
    };
    const comparison = await compareManagedConfigKey(edited, initial.state, "service_tier");
    expect(comparison.status).toBe("drifted");

    const merged = await mergeManagedRuntimeConfig(
      edited,
      initial.state,
      { service_tier: "fast", suppress_unstable_features_warning: true },
      metadata,
    );
    expect(merged.document["service_tier"]).toBe("default");
    expect(merged.driftedKeys).toEqual(["service_tier"]);
  });

  test("accepts only Codex runtime service-tier spellings", async () => {
    const state = createManagedRuntimeConfigState(metadata);
    const accepted = await mergeManagedRuntimeConfig(
      {},
      state,
      { service_tier: "default" },
      metadata,
    );
    expect(accepted.document["service_tier"]).toBe("default");

    for (const unsupported of ["standard", "fast-all"] as const) {
      await expect(
        mergeManagedRuntimeConfig({}, state, { service_tier: unsupported }, metadata),
      ).rejects.toMatchObject({ code: "invalid_external_data" });
    }
  });

  test("accepts Astra as the live root model and reports stale ownership metadata", async () => {
    const initial = await mergeManagedRuntimeConfig(
      {},
      createManagedRuntimeConfigState(metadata),
      { model: "gpt-6-astra" },
      metadata,
    );
    expect(initial.document["model"]).toBe("gpt-6-astra");
    expect(initial.state.managed["model"]?.lastManagedValue).toEqual({
      kind: "enum",
      value: "gpt-6-astra",
    });

    const staleState = {
      ...initial.state,
      managed: {
        ...initial.state.managed,
        model: { ...initial.state.managed["model"]!, installId: "different-install" },
      },
    };
    const cleanup = await cleanupManagedRuntimeConfig(initial.document, staleState, metadata);
    expect(cleanup.document["model"]).toBe("gpt-6-astra");
    expect(cleanup.unresolvedKeys).toEqual(["model"]);
    expect(cleanup.restoredKeys).toEqual([]);
  });

  test("recognizes historical model IDs when restoring previously managed values", async () => {
    for (const historicalModel of [
      "gpt-6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
    ] as const) {
      const initial = await mergeManagedRuntimeConfig(
        { model: historicalModel },
        createManagedRuntimeConfigState(metadata),
        { model: "gpt-6-astra" },
        metadata,
      );
      expect(initial.state.managed["model"]?.originalValue).toEqual({
        kind: "enum",
        value: historicalModel,
      });
      const cleaned = await cleanupManagedRuntimeConfig(initial.document, initial.state, metadata);
      expect(cleaned.document["model"]).toBe(historicalModel);
      expect(cleaned.restoredKeys).toEqual(["model"]);
      await expect(
        mergeManagedRuntimeConfig(
          {},
          createManagedRuntimeConfigState(metadata),
          { model: historicalModel },
          metadata,
        ),
      ).rejects.toMatchObject({ code: "invalid_external_data" });
    }
  });

  test("manages context experimental mode as a required Root setting", async () => {
    const keyPath = "features.context_management.experimental_mode" as const;
    expect(isManagedConfigKeyPath(keyPath)).toBe(true);
    const merged = await mergeManagedRuntimeConfig(
      { features: { context_management: { experimental_mode: false, unrelated: "keep" } } },
      createManagedRuntimeConfigState(metadata),
      { [keyPath]: true },
      metadata,
    );
    expect(readTomlPath(merged.document, keyPath)).toBe(true);
    expect(readTomlPath(merged.document, "features.context_management.unrelated")).toBe("keep");
    expect(merged.state.managed[keyPath]?.originalValue).toEqual({
      kind: "boolean",
      value: false,
    });
    expect(merged.state.managed[keyPath]?.lastManagedValue).toEqual({
      kind: "boolean",
      value: true,
    });
  });

  test("reconciles scalar context feature settings without changing their meaning", async () => {
    const keyPath = "features.context_management.experimental_mode" as const;
    const alreadyEnabled = await mergeManagedRuntimeConfig(
      { features: { context_management: true } },
      createManagedRuntimeConfigState(metadata),
      { [keyPath]: true },
      metadata,
    );
    expect(readTomlPath(alreadyEnabled.document, keyPath)).toBe(true);
    expect(alreadyEnabled.document).toEqual({ features: { context_management: true } });
    expect(alreadyEnabled.state.managed[keyPath]?.originalValue).toEqual({
      kind: "boolean",
      value: true,
    });
    const unchangedCleanup = await cleanupManagedRuntimeConfig(
      alreadyEnabled.document,
      alreadyEnabled.state,
      metadata,
    );
    expect(unchangedCleanup.document).toEqual({ features: { context_management: true } });

    const disabled = await mergeManagedRuntimeConfig(
      { features: { context_management: false } },
      createManagedRuntimeConfigState(metadata),
      { [keyPath]: true },
      metadata,
    );
    expect(readTomlPath(disabled.document, keyPath)).toBe(true);
    expect(disabled.state.managed[keyPath]?.originalValue).toEqual({
      kind: "boolean",
      value: false,
    });
    expect(disabled.document).toEqual({
      features: { context_management: { experimental_mode: true } },
    });
    const disabledCleanup = await cleanupManagedRuntimeConfig(
      disabled.document,
      disabled.state,
      metadata,
    );
    expect(readTomlPath(disabledCleanup.document, keyPath)).toBe(false);
  });

  test("represents all official-plugin IDs safely in quoted TOML paths", () => {
    for (const pluginId of ["Example/Inspector:1@OpenAI-Curated", "constructor", "prototype"]) {
      expect(Schema.is(OfficialPluginIdSchema)(pluginId)).toBe(true);
      const keyPath = `plugins.${JSON.stringify(pluginId)}`;
      const document = writeTomlPath({}, keyPath, { enabled: true });
      expect(readTomlPath(document, keyPath)).toEqual({ enabled: true });
      expect(document).toEqual({ plugins: { [pluginId]: { enabled: true } } });

      const enabledPath = `${keyPath}.enabled`;
      const nestedDocument = writeTomlPath({}, enabledPath, true);
      expect(readTomlPath(nestedDocument, enabledPath)).toBe(true);
      expect(nestedDocument).toEqual({ plugins: { [pluginId]: { enabled: true } } });
    }

    expect(() => writeTomlPath({}, 'plugins."__proto__"', true)).toThrow();
    expect(() => writeTomlPath({}, 'other."constructor"', true)).toThrow();
    expect(() => writeTomlPath({}, 'plugins."constructor".prototype', true)).toThrow();
  });

  test("manages supported Root feature flags explicitly", () => {
    expect(isManagedConfigKeyPath("features.default_mode_request_user_input")).toBe(true);
    expect(isManagedConfigKeyPath("features.agent_message_board")).toBe(true);
    for (const keyPath of [
      "include_collaboration_mode_instructions",
      "tools.experimental_request_user_input.enabled",
      "tools.update_plan.enabled",
      "features.goals",
      "features.image_generation",
      "features.memories",
      "features.request_permissions_tool",
      "features.skill_search",
      "features.sleep_tool",
    ]) {
      expect(isManagedConfigKeyPath(keyPath)).toBe(true);
    }
    expect(isManagedConfigKeyPath("features.multi_agent_v2")).toBe(false);
    expect(isManagedConfigKeyPath("features.multi_agent_v2.enabled")).toBe(true);
    expect(isManagedConfigKeyPath("features.multi_agent_v2.usage_hint_text")).toBe(true);
    expect(isManagedConfigKeyPath("features.code_mode.direct_only_tool_namespaces")).toBe(true);
    expect(isManagedConfigKeyPath("features.thread_tools")).toBe(false);
  });

  test("owns tool-control booleans and restores prior user values on cleanup", async () => {
    const desired = {
      include_collaboration_mode_instructions: false,
      "tools.experimental_request_user_input.enabled": false,
      "tools.update_plan.enabled": false,
      "features.goals": false,
      "features.image_generation": true,
      "features.memories": false,
      "features.request_permissions_tool": false,
      "features.skill_search": true,
      "features.sleep_tool": false,
    } as const;
    const original = {
      include_collaboration_mode_instructions: true,
      tools: {
        experimental_request_user_input: { enabled: true },
        update_plan: { enabled: true },
      },
      features: {
        goals: true,
        image_generation: false,
        memories: true,
        request_permissions_tool: true,
        skill_search: false,
        sleep_tool: true,
        unrelated: true,
      },
    } as const;
    const merged = await mergeManagedRuntimeConfig(
      original,
      createManagedRuntimeConfigState(metadata),
      desired,
      metadata,
    );

    for (const [keyPath, value] of Object.entries(desired)) {
      expect(isManagedConfigKeyPath(keyPath)).toBe(true);
      expect(readTomlPath(merged.document, keyPath)).toBe(value);
      expect(merged.state.managed[keyPath]?.lastManagedValue).toEqual({ kind: "boolean", value });
    }

    expect(readTomlPath(merged.document, "features.unrelated")).toBe(true);
    const cleaned = await cleanupManagedRuntimeConfig(merged.document, merged.state, metadata);
    expect(cleaned.document).toEqual(original);
  });

  test("manages V1 depth and direct-only tool configuration while preserving originals", async () => {
    const original = {
      model_catalog_json: "/home/user/custom-models.json",
      agents: {
        enabled: false,
        max_depth: 3,
        default: { config_file: "custom-default.toml" },
        worker: { config_file: "custom-worker.toml" },
      },
      features: {
        multi_agent_v2: { enabled: true, usage_hint_text: "User hint." },
        code_mode: { enabled: false, direct_only_tool_namespaces: ["mcp__notes"] },
      },
    };
    const merged = await mergeManagedRuntimeConfig(
      original,
      createManagedRuntimeConfigState(metadata),
      {
        "agents.max_depth": 1,
        "agents.enabled": true,
        "agents.default.config_file": "holycodex/agents/generation/sentinel-default.toml",
        "agents.worker.config_file": "holycodex/agents/generation/sentinel-worker.toml",
        model_catalog_json: "/home/user/.codex/holycodex/model-catalog.json",
        "features.multi_agent_v2.enabled": false,
        "features.multi_agent_v2.usage_hint_text": "Managed V1 hint.",
        "features.code_mode.enabled": true,
        "features.code_mode.direct_only_tool_namespaces": ["multi_agent_v1"],
      },
      metadata,
    );
    expect(readTomlPath(merged.document, "agents.max_depth")).toBe(1);
    expect(readTomlPath(merged.document, "agents.enabled")).toBe(true);
    expect(readTomlPath(merged.document, "agents.default.config_file")).toBe(
      "holycodex/agents/generation/sentinel-default.toml",
    );
    expect(readTomlPath(merged.document, "model_catalog_json")).toBe(
      "/home/user/.codex/holycodex/model-catalog.json",
    );
    expect(readTomlPath(merged.document, "features.multi_agent_v2.enabled")).toBe(false);
    expect(readTomlPath(merged.document, "features.multi_agent_v2.usage_hint_text")).toBe(
      "Managed V1 hint.",
    );
    expect(readTomlPath(merged.document, "features.code_mode.enabled")).toBe(true);
    expect(readTomlPath(merged.document, "features.code_mode.direct_only_tool_namespaces")).toEqual(
      ["multi_agent_v1"],
    );
    const cleaned = await cleanupManagedRuntimeConfig(merged.document, merged.state, metadata);
    expect(cleaned.document).toEqual(original);
  });

  test("restores an obsolete managed flag only while its installed value is unchanged", async () => {
    const keyPath = "features.agent_message_board" as const;
    const lastManagedValue = await summarizeManagedConfigValue(keyPath, false);
    const state = {
      ...createManagedRuntimeConfigState(metadata),
      managed: {
        [keyPath]: {
          owner: "holycodex",
          schema: metadata.schema,
          installId: metadata.installId,
          keyPath,
          originalValue: { kind: "boolean", value: true },
          lastManagedValue,
        },
      },
    } as const;
    const cleaned = await cleanupManagedRuntimeConfig(
      { features: { agent_message_board: false, unrelated: true } },
      state,
      metadata,
    );
    expect(readTomlPath(cleaned.document, keyPath)).toBe(true);
    expect(readTomlPath(cleaned.document, "features.unrelated")).toBe(true);

    const edited = await cleanupManagedRuntimeConfig(
      { features: { agent_message_board: true, unrelated: true } },
      state,
      metadata,
    );
    expect(readTomlPath(edited.document, keyPath)).toBe(true);
    expect(edited.preservedKeys).toEqual([keyPath]);
  });

  test("restores the prior context setting on removal and preserves user drift", async () => {
    const keyPath = "features.context_management.experimental_mode" as const;
    const initial = await mergeManagedRuntimeConfig(
      { features: { context_management: { experimental_mode: false } } },
      createManagedRuntimeConfigState(metadata),
      { [keyPath]: true },
      metadata,
    );
    const cleaned = await cleanupManagedRuntimeConfig(initial.document, initial.state, metadata);
    expect(readTomlPath(cleaned.document, keyPath)).toBe(false);
    expect(cleaned.restoredKeys).toEqual([keyPath]);

    const edited = writeTomlPath(initial.document, keyPath, false);
    const preserved = await cleanupManagedRuntimeConfig(edited, initial.state, metadata);
    expect(readTomlPath(preserved.document, keyPath)).toBe(false);
    expect(preserved.preservedKeys).toEqual([keyPath]);
    expect(preserved.restoredKeys).toEqual([]);
  });

  test("restores typed originals, removes additions, and keeps digest-only originals secret-safe", async () => {
    const priorInstructions = "Bearer prior-secret-instructions";
    const installedInstructions = "HolyCodex instructions";
    const initial = await mergeManagedRuntimeConfig(
      { model: "gpt-6.1-sol", developer_instructions: priorInstructions },
      createManagedRuntimeConfigState(metadata),
      { model: "gpt-6-luna", developer_instructions: installedInstructions },
      metadata,
    );
    const serializedState = JSON.stringify(initial.state);
    expect(serializedState).not.toContain(priorInstructions);
    expect(serializedState).not.toContain(installedInstructions);

    const cleaned = await cleanupManagedRuntimeConfig(initial.document, initial.state, metadata);
    expect(cleaned.document["model"]).toBe("gpt-6.1-sol");
    expect(readTomlPath(cleaned.document, "developer_instructions")).toBe(installedInstructions);
    expect(cleaned.restoredKeys).toEqual(["model"]);
    expect(cleaned.unresolvedKeys).toEqual(["developer_instructions"]);
    expect(
      isManagedRuntimeConfigState({
        owner: "holycodex",
        schema: metadata.schema,
        installId: metadata.installId,
        managed: {
          developer_instructions: {
            owner: "holycodex",
            schema: metadata.schema,
            installId: metadata.installId,
            keyPath: "developer_instructions",
            originalValue: "prior-secret-instructions",
            lastManagedValue: {
              kind: "digest",
              value: "0".repeat(64),
              raw: "prior-secret-instructions",
            },
          },
        },
      }),
    ).toBe(false);
  });

  test("resolves relative agent targets from the declaring config file", () => {
    expect(normalizeRelativeConfigPath("./holycodex\\agents\\Worker.implementation.toml")).toBe(
      "holycodex/agents/Worker.implementation.toml",
    );
    expect(
      resolveAgentConfigPath(
        "/opt/codex/config.toml",
        "holycodex/agents/Worker.implementation.toml",
      ),
    ).toBe("/opt/codex/holycodex/agents/Worker.implementation.toml");
    expect(() => normalizeRelativeConfigPath("../outside.toml")).toThrow();
    expect(() => normalizeRelativeConfigPath("/etc/secrets.toml")).toThrow();
  });

  test("manages quoted canonical agent registration keys", async () => {
    const keyPath = 'agents."Worker.implementation".config_file' as const;
    expect(isManagedConfigKeyPath(keyPath)).toBe(true);
    const document = writeTomlPath({}, keyPath, "holycodex/agents/Worker.implementation.toml");
    expect(readTomlPath(document, keyPath)).toBe("holycodex/agents/Worker.implementation.toml");
    const merged = await mergeManagedRuntimeConfig(
      {},
      createManagedRuntimeConfigState(metadata),
      { [keyPath]: "holycodex/agents/Worker.implementation.toml" },
      metadata,
    );
    expect(merged.driftedKeys).toEqual([]);
    expect(merged.state.managed[keyPath]?.lastManagedValue).toEqual({
      kind: "relative_path",
      value: "holycodex/agents/Worker.implementation.toml",
    });
  });

  test("manages Root multi-agent dispatch without obsolete feature flags", async () => {
    const v1 = "features.multi_agent" as const;
    expect(isManagedConfigKeyPath(v1)).toBe(true);
    const merged = await mergeManagedRuntimeConfig(
      {},
      createManagedRuntimeConfigState(metadata),
      { [v1]: true },
      metadata,
    );
    expect(readTomlPath(merged.document, v1)).toBe(true);
    expect(merged.state.managed[v1]?.lastManagedValue).toEqual({
      kind: "boolean",
      value: true,
    });
  });

  test("manages built-in Full Access and automatic approval review", async () => {
    const webSearch = "web_search" as const;
    const networkAccess = "sandbox_workspace_write.network_access" as const;
    const defaultPermissions = "default_permissions" as const;
    expect(isManagedConfigKeyPath(webSearch)).toBe(true);
    expect(isManagedConfigKeyPath(defaultPermissions)).toBe(true);
    expect(isManagedConfigKeyPath(networkAccess)).toBe(false);
    expect(LEGACY_ROOT_CONFIG_KEY_PATHS).toContain(networkAccess);
    const legacyProfileParent = "permissions.holycodex.extends" as const;
    const legacyProfileNetwork = "permissions.holycodex.network.enabled" as const;
    expect(isManagedConfigKeyPath(legacyProfileParent)).toBe(false);
    expect(isManagedConfigKeyPath(legacyProfileNetwork)).toBe(false);
    expect(LEGACY_ROOT_CONFIG_KEY_PATHS).toContain(legacyProfileParent);
    expect(LEGACY_ROOT_CONFIG_KEY_PATHS).toContain(legacyProfileNetwork);
    const approvalPolicy = "approval_policy" as const;
    const approvalsReviewer = "approvals_reviewer" as const;
    const merged = await mergeManagedRuntimeConfig(
      {},
      createManagedRuntimeConfigState(metadata),
      {
        [webSearch]: "live",
        [approvalPolicy]: "on-request",
        [approvalsReviewer]: "auto_review",
        [defaultPermissions]: ":danger-full-access",
      },
      metadata,
    );
    expect(readTomlPath(merged.document, webSearch)).toBe("live");
    expect(readTomlPath(merged.document, approvalPolicy)).toBe("on-request");
    expect(readTomlPath(merged.document, approvalsReviewer)).toBe("auto_review");
    expect(readTomlPath(merged.document, defaultPermissions)).toBe(":danger-full-access");
    expect(merged.state.managed[webSearch]?.lastManagedValue).toEqual({
      kind: "enum",
      value: "live",
    });
    expect(merged.state.managed[approvalPolicy]?.lastManagedValue).toEqual({
      kind: "enum",
      value: "on-request",
    });
    expect(merged.state.managed[approvalsReviewer]?.lastManagedValue).toEqual({
      kind: "enum",
      value: "auto_review",
    });
    expect(merged.state.managed[defaultPermissions]?.lastManagedValue).toEqual({
      kind: "enum",
      value: ":danger-full-access",
    });
  });

  test("manages the Root session thread limit as a numeric setting", async () => {
    const keyPath = "agents.max_concurrent_threads_per_session" as const;
    expect(isManagedConfigKeyPath(keyPath)).toBe(true);
    const merged = await mergeManagedRuntimeConfig(
      { agents: { max_concurrent_threads_per_session: 4, unrelated: true } },
      createManagedRuntimeConfigState(metadata),
      { [keyPath]: 21 },
      metadata,
    );
    expect(readTomlPath(merged.document, keyPath)).toBe(21);
    expect(readTomlPath(merged.document, "agents.unrelated")).toBe(true);
    expect(merged.state.managed[keyPath]?.lastManagedValue).toEqual({ kind: "number", value: 21 });
  });
});
