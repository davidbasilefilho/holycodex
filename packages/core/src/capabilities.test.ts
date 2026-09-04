// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";

import {
  canonicalOfficialPluginId,
  officialPluginIdCandidates,
  resolveOfficialPluginIdentity,
} from "./index.ts";

describe("official curated capability identities", () => {
  test("keeps canonical and Codex remote identities equivalent", () => {
    expect(canonicalOfficialPluginId("build-web-apps@openai-curated")).toBe(
      "build-web-apps@openai-curated",
    );
    expect(canonicalOfficialPluginId("build-web-apps@openai-curated-remote")).toBe(
      "build-web-apps@openai-curated",
    );
    expect(canonicalOfficialPluginId("codex-security@openai-curated-remote")).toBe(
      "codex-security@openai-curated",
    );
    expect(officialPluginIdCandidates("codex-security@openai-curated")).toEqual([
      "codex-security@openai-curated",
      "codex-security@openai-curated-remote",
    ]);
    expect(
      resolveOfficialPluginIdentity(
        "build-web-apps@openai-curated-remote",
        "openai-curated-remote",
      ),
    ).toMatchObject({
      pluginName: "build-web-apps",
      marketplaceName: "openai-curated-remote",
      canonicalPluginId: "build-web-apps@openai-curated",
    });
  });

  test("rejects third-party aliases and mismatched marketplace metadata", () => {
    expect(canonicalOfficialPluginId("build-web-apps@crowdstrike")).toBeUndefined();
    expect(
      resolveOfficialPluginIdentity("build-web-apps@openai-curated-remote", "crowdstrike"),
    ).toBeUndefined();
    expect(
      resolveOfficialPluginIdentity("build-web-apps@openai-curated", undefined),
    ).toBeUndefined();
    expect(officialPluginIdCandidates("build-web-apps@crowdstrike")).toEqual([]);
  });
});
