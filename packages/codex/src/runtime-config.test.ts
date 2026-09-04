// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
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

  test("manages context experimental mode as a strict boolean", async () => {
    const keyPath = "features.context_management.experimental_mode" as const;
    expect(isManagedConfigKeyPath(keyPath)).toBe(true);
    const initial = await mergeManagedRuntimeConfig(
      { features: { context_management: { unrelated: "preserve" } } },
      createManagedRuntimeConfigState(metadata),
      { [keyPath]: true },
      metadata,
    );

    expect(readTomlPath(initial.document, keyPath)).toBe(true);
    expect(initial.state.managed[keyPath]?.originalValue).toEqual({ kind: "absent" });
    const unchanged = await compareManagedConfigKey(initial.document, initial.state, keyPath);
    expect(unchanged).toMatchObject({
      status: "unchanged",
      current: { kind: "boolean", value: true },
    });

    const edited = writeTomlPath(initial.document, keyPath, false);
    const drifted = await compareManagedConfigKey(edited, initial.state, keyPath);
    expect(drifted).toMatchObject({
      status: "drifted",
      current: { kind: "boolean", value: false },
    });
    const preserved = await mergeManagedRuntimeConfig(
      edited,
      initial.state,
      { [keyPath]: true },
      metadata,
    );
    expect(readTomlPath(preserved.document, keyPath)).toBe(false);
    expect(preserved.driftedKeys).toEqual([keyPath]);

    const cleaned = await cleanupManagedRuntimeConfig(initial.document, initial.state, metadata);
    expect(readTomlPath(cleaned.document, keyPath)).toBeUndefined();
    expect(readTomlPath(cleaned.document, "features.context_management.unrelated")).toBe(
      "preserve",
    );
    expect(cleaned.restoredKeys).toEqual([keyPath]);
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
    expect(normalizeRelativeConfigPath("./holycodex\\agents\\worker.toml")).toBe(
      "holycodex/agents/worker.toml",
    );
    expect(resolveAgentConfigPath("/opt/codex/config.toml", "holycodex/agents/worker.toml")).toBe(
      "/opt/codex/holycodex/agents/worker.toml",
    );
    expect(() => normalizeRelativeConfigPath("../outside.toml")).toThrow();
    expect(() => normalizeRelativeConfigPath("/etc/secrets.toml")).toThrow();
  });
});
