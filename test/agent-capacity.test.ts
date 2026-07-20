import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAgentCapacity, readAgentCapacity } from "../packages/cli/src/agent-capacity.ts";
import { coreInstructions } from "../packages/cli/src/core-instructions.ts";

describe("agent capacity context", () => {
  it("parses only complete positive limits from the root agents table", () => {
    expect(
      parseAgentCapacity(
        "[agents]\nmax_threads = 2 # root included\nmax_depth = 1\n[agents.worker]\nmax_threads = 99",
      ),
    ).toEqual({ maxThreads: 2, maxDepth: 1 });
    expect(parseAgentCapacity("[agents]\nmax_threads = 0\nmax_depth = 1")).toBeUndefined();
    expect(parseAgentCapacity("[agents]\nmax_threads = 2")).toBeUndefined();
  });

  it("reads limits and degrades when config is unavailable", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "holycodex-capacity-"));
    expect(await readAgentCapacity(codexHome)).toBeUndefined();
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), "[agents]\nmax_threads=2\nmax_depth=1\n");
    expect(await readAgentCapacity(codexHome)).toEqual({ maxThreads: 2, maxDepth: 1 });
  });

  it("explains root-inclusive capacity and fallback authority", () => {
    expect(coreInstructions("linux", { maxThreads: 2, maxDepth: 1 })).toContain(
      "Root can run at most 1 direct child agent concurrently",
    );
    expect(coreInstructions("linux")).toContain(
      "active collaboration tool instructions as the authoritative agent-capacity limit",
    );
  });

  it("uses native Codex workspace I/O", () => {
    const instructions = coreInstructions("linux");

    expect(instructions).toContain("Use Codex native `apply_patch`");
    expect(instructions).toContain("Use available native read or shell tools");
    expect(instructions).toContain(
      "Do not re-read files only to verify a successful `apply_patch` call",
    );
  });
});
