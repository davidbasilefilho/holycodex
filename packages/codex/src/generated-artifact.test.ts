// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { verifyGeneratedArtifact } from "./generated-artifact";

describe("codex-cli 0.148.0 generated artifact provenance", () => {
  test("verifies the recorded binary, protocol epoch, and sorted artifact inventory", async () => {
    const verification = await verifyGeneratedArtifact({ verifyExecutable: false });
    expect(verification.protocol_epoch).toBe("codex-app-server-0.148.0");
    expect(verification.executable.version).toBe("codex-cli 0.148.0");
    expect(verification.executable.sha256).toBe(
      "ac2cfed85fb647d61e0150b8548102b330e4799d9d81ad5d354de701edf6b074",
    );
    expect(verification.inventory.count).toBe(943);
    expect(verification.inventory.digest).toBe(
      "24436be19cd8ea368d18154da5d8354b9b6ce1671da1fb49e958a6341d3e7d7d",
    );
    expect(verification.inventory.files).toEqual(
      [...verification.inventory.files].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
    );
    expect(verification.multi_agent_v2_lifecycle).toBe("unverified");
  });

  test("can verify the checked-in artifact without executing the binary", async () => {
    const verification = await verifyGeneratedArtifact({ verifyExecutable: false });
    expect(verification.inventory.count).toBe(943);
  });
});
