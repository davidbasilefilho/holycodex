import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CODEX_SLIM_EDIT_VERSION, isVersionRequest } from "./version.js";

describe("codexslimedit version", () => {
  it("keeps an independent zerover version", () => {
    expect(CODEX_SLIM_EDIT_VERSION).toMatch(/^0\.\d+\.\d+$/);
  });

  it("matches the published package manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe(CODEX_SLIM_EDIT_VERSION);
  });

  it("recognizes version probes without consuming other arguments", () => {
    expect(isVersionRequest(["--version"])).toBe(true);
    expect(isVersionRequest(["serve"])).toBe(false);
  });
});
