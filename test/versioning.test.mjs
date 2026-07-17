import { describe, expect, it } from "vitest";

import { nextDevVersion, nextZeroVersion, versionedJson } from "../scripts/version.mjs";

describe("zerover versioning", () => {
  it("bumps fixes on the patch component", () => {
    expect(nextZeroVersion("0.2.0", "patch")).toBe("0.2.1");
  });

  it("bumps breaking changes on the second component", () => {
    expect(nextZeroVersion("0.2.7", "minor")).toBe("0.3.0");
  });

  it("accepts an explicit zerover version and rejects 1.x", () => {
    expect(nextZeroVersion("0.2.0", "0.4.3")).toBe("0.4.3");
    expect(() => nextZeroVersion("0.2.0", "1.0.0")).toThrow(/Usage/);
  });

  it("derives unique npm dev-channel prerelease versions", () => {
    expect(nextDevVersion("0.6.0", "42", "3")).toBe("0.6.0-dev.42.3");
    expect(nextDevVersion("0.6.0-rc.2", "42", "3")).toBe("0.6.0-dev.42.3");
    expect(() => nextDevVersion("0.6.0", "run", "1")).toThrow(/Usage/);
  });

  it("keeps the CLI and plugin package versions exact", () => {
    const source = {
      name: "holycodex",
      version: "0.6.0",
      dependencies: { "@holycodex/plugin": "0.6.0", retained: "1.0.0" },
    };
    expect(versionedJson("packages/cli/package.json", source, "0.6.0-dev.4.2")).toEqual({
      ...source,
      version: "0.6.0-dev.4.2",
      dependencies: { "@holycodex/plugin": "0.6.0-dev.4.2", retained: "1.0.0" },
    });
  });
});
