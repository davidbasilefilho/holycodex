import { describe, expect, it } from "vitest";
import { nextZeroVersion } from "../scripts/version.mjs";

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
});
