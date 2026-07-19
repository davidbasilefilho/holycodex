import { describe, expect, it } from "vitest";

import { CODEX_SLIM_EDIT_VERSION, isVersionRequest } from "./version.js";

describe("codexslimedit version", () => {
  it("keeps an independent zerover version", () => {
    expect(CODEX_SLIM_EDIT_VERSION).toMatch(/^0\.\d+\.\d+$/);
  });

  it("recognizes version probes without consuming other arguments", () => {
    expect(isVersionRequest(["--version"])).toBe(true);
    expect(isVersionRequest(["serve"])).toBe(false);
  });
});
