// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { verifyGeneratedArtifact } from "./generated-artifact";

describe("generated Codex artifact provenance", () => {
  test("verifies the recorded binary, protocol epoch, and sorted artifact inventory", async () => {
    const verification = await verifyGeneratedArtifact({ verifyExecutable: false });
    expect(verification.protocol_epoch).toMatch(/^codex-app-server-\d+\.\d+\.\d+$/u);
    expect(verification.executable.version).toMatch(/^codex-cli \d+\.\d+\.\d+$/u);
    expect(verification.executable.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(verification.inventory.count).toBeGreaterThan(0);
    expect(verification.inventory.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(verification.inventory.files).toEqual(
      [...verification.inventory.files].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
    );
    expect(verification.multi_agent_v2_lifecycle).toBe("unverified");
  });
});
