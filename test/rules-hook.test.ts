import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRules, runRulesHook } from "../packages/cli/src/rules-hook.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "holycodex-rules-test-"));
  await mkdir(join(root, ".holycodex", "rules"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "never inject this", "utf8");
  await writeFile(join(root, "CONTEXT.md"), "shared project context", "utf8");
  await writeFile(
    join(root, ".holycodex", "rules", "typescript.md"),
    '---\nglobs: ["src/**/*.ts"]\n---\nuse strict types',
    "utf8",
  );
  return root;
}

describe("scoped rules", () => {
  it("loads static sources without AGENTS.md", async () => {
    const root = await fixture();
    const rules = await loadRules(root);
    expect(rules.map((rule) => rule.body)).toEqual(["shared project context"]);
  });

  it("loads only rules matching edited path", async () => {
    const root = await fixture();
    const matching = await loadRules(root, join(root, "src", "feature", "index.ts"));
    const unrelated = await loadRules(root, join(root, "README.md"));
    expect(matching.map((rule) => rule.body)).toContain("use strict types");
    expect(unrelated.map((rule) => rule.body)).not.toContain("use strict types");
  });

  it.each([
    ["unquoted scalar", "globs: src/**/*.ts"],
    ["quoted scalar", 'globs: "src/**/*.ts"'],
    ["unquoted inline array", "globs: [src/**/*.ts, test/**/*.ts]"],
    ["quoted inline array", 'globs: ["src/**/*.ts", "test/**/*.ts"]'],
    ["multiline array", "globs:\n  - src/**/*.ts\n  - 'test/**/*.ts'"],
  ])("parses %s globs", async (_name, frontmatter) => {
    const root = await fixture();
    await writeFile(
      join(root, ".holycodex", "rules", "forms.md"),
      `---\n${frontmatter}\n---\nparsed form`,
      "utf8",
    );
    expect(await loadRules(root, join(root, "src", "feature", "index.ts"))).toContainEqual(
      expect.objectContaining({ body: "parsed form" }),
    );
  });

  it("deduplicates native transcript rules and resets its cache after compaction", async () => {
    const root = await fixture();
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, '{"content":"shared project context"}\n');
    const input = {
      hook_event_name: "SessionStart",
      session_id: root,
      cwd: root,
      transcript_path: transcript,
    } as const;
    expect(await runRulesHook(input)).toBe("");
    await writeFile(transcript, "");
    expect(await runRulesHook(input)).toContain("shared project context");
    expect(await runRulesHook(input)).toBe("");
    expect(await runRulesHook({ ...input, hook_event_name: "PostCompact" })).toContain(
      'Root is the default user-facing agent. Start the first user-facing update: \\"I detect ',
    );
    expect(await runRulesHook(input)).toContain("shared project context");
  });
});
