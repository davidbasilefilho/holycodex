// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import {
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  createManagedRuntimeConfigState,
  isManagedRuntimeConfigState,
  isManagedConfigKeyPath,
  mergeManagedRuntimeConfig,
  normalizeRelativeConfigPath,
  readTomlPath,
  resolveAgentConfigPath,
  writeTomlPath,
} from "./runtime-config";

const metadata = { schema: "state-0.16", installId: "install-1" } as const;

describe("typed runtime configuration", () => {
  test("merges managed dotted keys while retaining unrelated TOML tables", async () => {
    const document = {
      model: "gpt-6-sol",
      unrelated: "preserve",
      features: { unrelated_feature: true },
    } as const;
    const merged = await mergeManagedRuntimeConfig(
      document,
      createManagedRuntimeConfigState(metadata),
      {
        model: "gpt-6-luna",
        "features.default_mode_request_user_input": true,
      },
      metadata,
    );

    expect(merged.document).toEqual({
      model: "gpt-6-luna",
      unrelated: "preserve",
      features: { unrelated_feature: true, default_mode_request_user_input: true },
    });
    expect(merged.state.managed["model"]?.originalValue).toEqual({
      kind: "enum",
      value: "gpt-6-sol",
    });
    expect(merged.state.managed["features.default_mode_request_user_input"]?.originalValue).toEqual(
      {
        kind: "absent",
      },
    );
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
    for (const historicalModel of ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"] as const) {
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

  test("manages scalar context management without changing unrelated feature settings", async () => {
    const keyPath = "features.context_management" as const;
    const merged = await mergeManagedRuntimeConfig(
      { features: { context_management: false, unrelated: "keep" } },
      createManagedRuntimeConfigState(metadata),
      { [keyPath]: true },
      metadata,
    );
    expect(readTomlPath(merged.document, keyPath)).toBe(true);
    expect(readTomlPath(merged.document, "features.unrelated")).toBe("keep");
    const cleaned = await cleanupManagedRuntimeConfig(merged.document, merged.state, metadata);
    expect(readTomlPath(cleaned.document, keyPath)).toBe(false);
    expect(readTomlPath(cleaned.document, "features.unrelated")).toBe("keep");
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
      { model: "gpt-6-sol", developer_instructions: priorInstructions },
      createManagedRuntimeConfigState(metadata),
      { model: "gpt-6-luna", developer_instructions: installedInstructions },
      metadata,
    );
    const serializedState = JSON.stringify(initial.state);
    expect(serializedState).not.toContain(priorInstructions);
    expect(serializedState).not.toContain(installedInstructions);

    const cleaned = await cleanupManagedRuntimeConfig(initial.document, initial.state, metadata);
    expect(cleaned.document["model"]).toBe("gpt-6-sol");
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

  test("manages Root V1 dispatch while disabling message board and V2", async () => {
    const v1 = "features.multi_agent" as const;
    const messageBoard = "features.agent_message_board" as const;
    const v2 = "features.multi_agent_v2" as const;
    expect(isManagedConfigKeyPath(v1)).toBe(true);
    expect(isManagedConfigKeyPath(messageBoard)).toBe(true);
    expect(isManagedConfigKeyPath(v2)).toBe(true);
    const merged = await mergeManagedRuntimeConfig(
      {},
      createManagedRuntimeConfigState(metadata),
      { [v1]: true, [messageBoard]: false, [v2]: false },
      metadata,
    );
    expect(readTomlPath(merged.document, v1)).toBe(true);
    expect(readTomlPath(merged.document, messageBoard)).toBe(false);
    expect(readTomlPath(merged.document, v2)).toBe(false);
    expect(merged.state.managed[v1]?.lastManagedValue).toEqual({
      kind: "boolean",
      value: true,
    });
    expect(merged.state.managed[messageBoard]?.lastManagedValue).toEqual({
      kind: "boolean",
      value: false,
    });
    expect(merged.state.managed[v2]?.lastManagedValue).toEqual({
      kind: "boolean",
      value: false,
    });
  });

  test("manages live web search and workspace command network access", async () => {
    const webSearch = "web_search" as const;
    const networkAccess = "sandbox_workspace_write.network_access" as const;
    expect(isManagedConfigKeyPath(webSearch)).toBe(true);
    expect(isManagedConfigKeyPath(networkAccess)).toBe(true);
    const merged = await mergeManagedRuntimeConfig(
      {},
      createManagedRuntimeConfigState(metadata),
      { [webSearch]: "live", [networkAccess]: true },
      metadata,
    );
    expect(readTomlPath(merged.document, webSearch)).toBe("live");
    expect(readTomlPath(merged.document, networkAccess)).toBe(true);
    expect(merged.state.managed[webSearch]?.lastManagedValue).toEqual({
      kind: "enum",
      value: "live",
    });
    expect(merged.state.managed[networkAccess]?.lastManagedValue).toEqual({
      kind: "boolean",
      value: true,
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
