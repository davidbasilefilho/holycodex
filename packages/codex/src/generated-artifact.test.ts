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
    expect(verification.inventory.count).toBe(655);
    expect(verification.inventory.digest).toBe(
      "ce20023cb681bfaf8f2d6911a42735bb218541781b873e09b167e8efe0a1fed4",
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
    expect(verification.inventory.count).toBe(655);
  });
});
