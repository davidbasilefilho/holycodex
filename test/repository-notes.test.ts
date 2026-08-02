import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const notesPath = [".agents", "NOTES.md"].join("/");

describe("repository notes contract", () => {
  it("records durable external-protocol findings without sensitive data", async () => {
    const notes = await readFile(notesPath, "utf8");
    expect(notes).toContain("codex-cli 0.145.0");
    expect(notes).toContain("codex-security@openai-curated");
    expect(notes).toContain("shell-free with fixed argument arrays");
    expect(notes).toContain("sanitized deterministic fixtures");
    expect(notes).not.toMatch(/(?:token|secret|password|authorization)\s*[:=]\s*\S+/i);
  });
});
