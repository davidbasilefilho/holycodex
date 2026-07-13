import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

async function skill(name: string): Promise<string> {
  return readFile(join(root, "plugin", "skills", name, "SKILL.md"), "utf8");
}

function expectOrder(text: string, phrases: readonly string[]): void {
  let previous = -1;
  for (const phrase of phrases) {
    const current = text.indexOf(phrase);
    expect(current, `missing ordered phrase: ${phrase}`).toBeGreaterThan(previous);
    previous = current;
  }
}

describe("instruction workflow contracts", () => {
  it("routes every skill from concrete task needs", async () => {
    const triggers = new Map<string, RegExp>([
      ["ast-grep", /syntax-aware code search|structural rewrite/],
      ["caveman", /terse replies|prompt and instruction edits/],
      ["comment-checker", /comment-checker warning/],
      ["compress", /text, prompts, or instructions shortened/],
      ["debugging", /crash, wrong result, hang, race, leak, slowdown/],
      ["define-goal", /asks to define a goal|accepts a goal/],
      ["frontend", /frontend, web UI, UX, visual design/],
      ["handoff", /resumable context transferred/],
      ["lsp", /semantic diagnostics, definitions, references/],
      ["lsp-setup", /language-server installation or configuration/],
      ["plan", /asks for a plan|complex, risky, ambiguous, or multi-stage/],
      ["plan-review", /complete initial implementation plan/],
      ["programming", /edits Python, Rust, TypeScript, Go/],
      ["refactor", /behavior-preserving restructuring/],
      ["remove-ai-slops", /remove AI-generated code smells/],
      ["rules", /rules are discovered, matched, injected/],
      ["security-research", /security review, threat analysis, vulnerability validation/],
      ["tdd", /TDD, regression coverage, integration tests/],
    ]);
    for (const [name, trigger] of triggers) {
      const description = (await skill(name)).match(/^description: (.*)$/m)?.[1] ?? "";
      expect(description).toMatch(/^Use when /);
      expect(description).toMatch(trigger);
      expect(description).toMatch(/do not/);
      expect(description).toMatch(/Produces|Applies|Creates/);
    }
  });

  it("keeps the complete skill graph compact", async () => {
    const names = [
      "ast-grep",
      "caveman",
      "comment-checker",
      "compress",
      "debugging",
      "define-goal",
      "frontend",
      "handoff",
      "lsp",
      "lsp-setup",
      "plan",
      "plan-review",
      "programming",
      "refactor",
      "remove-ai-slops",
      "rules",
      "security-research",
      "tdd",
    ] as const;
    const lineCounts = await Promise.all(
      names.map(async (name) => (await skill(name)).trimEnd().split("\n").length),
    );
    expect(Math.max(...lineCounts)).toBeLessThanOrEqual(70);
    expect(lineCounts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(500);
  });

  it("keeps planning draft, review, approval, and optional goal phases ordered", async () => {
    const text = await skill("plan");
    expectOrder(text, [
      "Load `plan`",
      "Write the complete initial plan",
      "Only after the initial plan exists, load `plan-review`",
      "Use `plan-review` once",
      "ask for approval",
      "After approval, ask whether the user wants to define a goal",
      "Only after explicit agreement, load `define-goal`",
    ]);
    expect(text).toContain("Never preload, parallelize, or imply its review.");
    expect(text).toContain("Do not implement before approval.");
  });

  it("makes plan review a one-pass repair of an existing plan", async () => {
    const text = await skill("plan-review");
    for (const concern of [
      "feasibility",
      "missing steps",
      "unnecessary work",
      "sequencing",
      "risks",
      "ambiguities",
      "completion criteria",
      "unverifiable outcomes",
    ]) {
      expect(text).toContain(concern);
    }
    expect(text).toContain("Revise or rewrite directly");
    expect(text).toContain("If no initial plan exists, stop");
    expect(text).toContain("No reviewer agent");
  });

  it("loads goal definition only by consent and gives goals a hard stop", async () => {
    const plan = await skill("plan");
    const frontend = await skill("frontend");
    const goal = await skill("define-goal");
    expect(plan).toContain("Only after explicit agreement, load `define-goal`");
    expect(frontend).toContain("Only after explicit agreement load `define-goal`");
    expect(goal).toContain("do not infer consent from implementation");
    expect(goal).toContain("explicit stop condition");
    expect(goal).toContain("Stop once the objective's criteria pass");
    expect(goal).toContain("polishing, speculative expansion, repeated review, adjacent work");
  });

  it("gates frontend implementation on context-specific design approval", async () => {
    const text = await skill("frontend");
    expectOrder(text, [
      "inspect the request, product shell",
      "Select only material design decisions",
      "ask for approval before implementation",
      "After approval, ask whether the user wants to define a goal",
      "otherwise implement",
    ]);
    expect(text).toContain("Preserve established decisions unless change is requested.");
    expect(text).toContain("include only decisions that alter user-visible design");
    expect(text).toContain("implementation details need no approval");
    expect(text).toContain("Avoid generic AI styling");
  });

  it("keeps adjacent skill routes distinct", async () => {
    const pairs = [
      ["ast-grep", "unlike LSP"],
      ["compress", "unlike caveman"],
      ["debugging", "unlike TDD"],
      ["lsp", "unlike lsp-setup"],
      ["plan-review", "unlike plan"],
      ["refactor", "unlike remove-ai-slops"],
      ["security-research", "unlike debugging"],
      ["tdd", "unlike debugging"],
    ] as const;
    for (const [name, boundary] of pairs) {
      expect((await skill(name)).toLowerCase()).toContain(boundary.toLowerCase());
    }
  });
});
