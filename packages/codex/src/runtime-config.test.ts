// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import {
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  createManagedRuntimeConfigState,
  isManagedRuntimeConfigState,
  isLegacyManagedConfigKeyPath,
  isManagedConfigKeyPath,
  mergeManagedRuntimeConfig,
  migrateLegacyManagedRuntimeConfig,
  normalizeRelativeConfigPath,
  readTomlPath,
  resolveAgentConfigPath,
  writeTomlPath,
} from "./runtime-config";

const metadata = { schema: "state-0.16", installId: "install-1" } as const;

describe("typed runtime configuration", () => {
  test("merges managed dotted keys while retaining unrelated TOML tables", async () => {
    const document = {
      model: "gpt-5.6-luna",
      unrelated: "preserve",
      features: { unrelated_feature: true },
    } as const;
    const merged = await mergeManagedRuntimeConfig(
      document,
      createManagedRuntimeConfigState(metadata),
      {
        model: "gpt-5.6-terra",
        "features.default_mode_request_user_input": true,
      },
      metadata,
    );

    expect(merged.document).toEqual({
      model: "gpt-5.6-terra",
      unrelated: "preserve",
      features: { unrelated_feature: true, default_mode_request_user_input: true },
    });
    expect(merged.state.managed["model"]?.originalValue).toEqual({
      kind: "enum",
      value: "gpt-5.6-luna",
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

  test("does not manage context experimental mode in the live key set", async () => {
    const keyPath = "features.context_management.experimental_mode" as const;
    expect(isManagedConfigKeyPath(keyPath)).toBe(false);
    expect(isLegacyManagedConfigKeyPath(keyPath)).toBe(true);
    await expect(
      mergeManagedRuntimeConfig(
        {},
        createManagedRuntimeConfigState(metadata),
        { [keyPath]: true } as unknown as Partial<Record<string, string | boolean>>,
        metadata,
      ),
    ).rejects.toMatchObject({ code: "invalid_external_data" });
  });

  test("relinquishes legacy context ownership without overwriting user edits", async () => {
    const keyPath = "features.context_management.experimental_mode" as const;
    const state = {
      ...createManagedRuntimeConfigState(metadata),
      managed: {
        [keyPath]: {
          owner: "holycodex" as const,
          schema: metadata.schema,
          installId: metadata.installId,
          keyPath,
          originalValue: { kind: "absent" as const },
          lastManagedValue: { kind: "boolean" as const, value: true },
        },
      },
    };
    expect(isManagedRuntimeConfigState(state)).toBe(true);

    const restored = await migrateLegacyManagedRuntimeConfig(
      { features: { context_management: { experimental_mode: true, unrelated: "keep" } } },
      state,
      metadata,
    );
    expect(readTomlPath(restored.document, keyPath)).toBeUndefined();
    expect(readTomlPath(restored.document, "features.context_management.unrelated")).toBe("keep");
    expect(restored.state.managed[keyPath]).toBeUndefined();
    expect(restored.restoredKeys).toEqual([keyPath]);
    expect(restored.preservedKeys).toEqual([]);

    const preserved = await migrateLegacyManagedRuntimeConfig(
      { features: { context_management: { experimental_mode: false, unrelated: "keep" } } },
      state,
      metadata,
    );
    expect(readTomlPath(preserved.document, keyPath)).toBe(false);
    expect(readTomlPath(preserved.document, "features.context_management.unrelated")).toBe("keep");
    expect(preserved.state.managed[keyPath]).toBeUndefined();
    expect(preserved.restoredKeys).toEqual([]);
    expect(preserved.preservedKeys).toEqual([keyPath]);
  });

  test("reports legacy ownership from another installation as unresolved", async () => {
    const keyPath = "features.context_management.experimental_mode" as const;
    const state = {
      ...createManagedRuntimeConfigState(metadata),
      managed: {
        [keyPath]: {
          owner: "holycodex" as const,
          schema: metadata.schema,
          installId: "different-install",
          keyPath,
          originalValue: { kind: "absent" as const },
          lastManagedValue: { kind: "boolean" as const, value: true },
        },
      },
    };
    const migrated = await migrateLegacyManagedRuntimeConfig(
      { features: { context_management: { experimental_mode: true, unrelated: "keep" } } },
      state,
      metadata,
    );
    expect(migrated.document).toEqual({
      features: { context_management: { experimental_mode: true, unrelated: "keep" } },
    });
    expect(migrated.unresolvedKeys).toEqual([keyPath]);
    expect(migrated.preservedKeys).toEqual([keyPath]);
    expect(migrated.state.managed[keyPath]).toBeDefined();
  });

  test("restores typed originals, removes additions, and keeps digest-only originals secret-safe", async () => {
    const priorInstructions = "Bearer prior-secret-instructions";
    const installedInstructions = "HolyCodex instructions";
    const initial = await mergeManagedRuntimeConfig(
      { model: "gpt-5.6-luna", developer_instructions: priorInstructions },
      createManagedRuntimeConfigState(metadata),
      { model: "gpt-5.6-terra", developer_instructions: installedInstructions },
      metadata,
    );
    const serializedState = JSON.stringify(initial.state);
    expect(serializedState).not.toContain(priorInstructions);
    expect(serializedState).not.toContain(installedInstructions);

    const cleaned = await cleanupManagedRuntimeConfig(initial.document, initial.state, metadata);
    expect(cleaned.document["model"]).toBe("gpt-5.6-luna");
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
});
