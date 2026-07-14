import { readFile, readdir } from "node:fs/promises";
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
  it("keeps routed skills dense and bounded by prompt cost", async () => {
    const names = (await readdir(join(root, "plugin", "skills"))).sort();
    expect(names).toHaveLength(16);
    const texts = await Promise.all(names.map(skill));
    for (const text of texts) {
      const description = text.match(/^description: (.*)$/m)?.[1] ?? "";
      expect(description).toMatch(/^Use when /);
      expect(description).toMatch(/do not/);
      expect(description).toMatch(/Produces|Applies|Creates/);
      expect(text.length).toBeLessThanOrEqual(5_000);
    }
    expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(26_800);
  });

  it("bounds the complete routed instruction surface", async () => {
    const skillsRoot = join(root, "plugin", "skills");
    const references = (await readdir(skillsRoot, { recursive: true }))
      .filter((path) => path.endsWith(".md") && !path.endsWith("ATTRIBUTION.md"))
      .map((path) => readFile(join(skillsRoot, path), "utf8"));
    const agentsRoot = join(root, "plugin", "agents");
    const agents = (await readdir(agentsRoot))
      .filter((path) => path.endsWith(".toml"))
      .map((path) => readFile(join(agentsRoot, path), "utf8"));
    const texts = await Promise.all([
      ...references,
      ...agents,
      readFile(join(root, "src", "core-instructions.ts"), "utf8"),
    ]);
    expect(texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(
      43_700,
    );
  });

  it("routes representative requests without adjacent skills or needless delegation", async () => {
    const cases = [
      {
        request: "Fix a reproducible parser defect",
        expected: [
          ["debugging", /crash, wrong result/],
          ["programming", /edits Python, Rust, TypeScript, Go/],
        ],
        forbidden: [["plan", /multiple obvious steps/]],
        delegation: "local",
      },
      {
        request: "Plan an irreversible cross-cutting architecture migration",
        expected: [
          ["plan", /unresolved architecture, cross-cutting coordination, irreversible decisions/],
        ],
        forbidden: [["plan-review", /do not use before initial drafting/]],
        delegation: "local",
      },
      {
        request: "Find the exact callers of parseRule in this repository",
        expected: [["lsp", /definitions, references/]],
        forbidden: [["lsp-setup", /do not use when an existing server works/]],
        delegation: "explorer",
      },
      {
        request: "Implement one isolated fixed-file TypeScript change",
        expected: [["programming", /edits Python, Rust, TypeScript, Go/]],
        forbidden: [["plan", /multiple obvious steps/]],
        delegation: "worker",
      },
    ] as const;
    for (const route of cases) {
      expect(route.request.length).toBeGreaterThan(0);
      for (const [name, contract] of route.expected) expect(await skill(name)).toMatch(contract);
      for (const [name, contract] of route.forbidden) expect(await skill(name)).toMatch(contract);
      expect(["local", "explorer", "worker"]).toContain(route.delegation);
    }
  });

  it("orders planning, one review, approval, optional goal, and stop", async () => {
    const text = await skill("plan");
    expect(text).toContain("do not use for multiple obvious steps");
    expectOrder(text, [
      "Load `plan`",
      "Write the complete initial plan",
      "Only after the initial plan exists, load `plan-review`",
      "Use `plan-review` once",
      "ask for approval",
      "After approval, ask whether the user wants to define a goal",
      "Only after explicit agreement, load `define-goal`",
    ]);
    expect(text).toContain("Do not implement before approval.");
    expect(text).toContain("Stop planning after approval and the optional goal choice");

    const review = await skill("plan-review");
    expect(review).toContain("If no initial plan exists, stop");
    expect(review).toContain("One pass:");
    expect(review).toContain(
      "No reviewer agent, evidence folder, second review loop, or implementation.",
    );
  });

  it("distinguishes defect, new behavior, covered, and nonbehavior testing", async () => {
    const text = await skill("programming");
    expect(text).toContain("Defect: add a public-seam regression test first");
    expect(text).toContain(
      "Explicit test-first request or clearly defined new behavior without adequate proof",
    );
    expect(text).toContain("Existing tests may lock small covered changes");
    expect(text).toContain(
      "Do not force red-green for prose, configuration-only work, trivial mechanical edits",
    );
  });

  it("requires one reusable implementation for shared behavior", async () => {
    const text = await skill("programming");
    expect(text).toContain("One behavior, one implementation");
    expect(text).toContain("Search before writing; reuse or extend the existing implementation");
    expect(text).toContain("Never copy-paste logic or maintain parallel variants");
    expect(text).toContain(
      "Put shared behavior in the smallest stable function, method, type, or module at its common ownership seam",
    );
    expect(text).toContain("Extract repetition when a second caller or copy exists");
  });

  it("gates visible frontend direction and always covers motion and accessibility", async () => {
    const text = await skill("frontend");
    expectOrder(text, [
      "inspect the request, product shell",
      "plus a motion system and accessibility treatment for every task",
      "ask for approval before implementation",
      "After approval, ask whether the user wants to define a goal",
      "otherwise implement",
    ]);
    for (const contract of [
      "prefers-reduced-motion",
      "keyboard operation",
      "focus visibility",
      "semantic",
      "contrast",
      "labels",
      "loading, error, and empty states",
      "options only when they fit product, task, and stack",
    ])
      expect(text).toContain(contract);
    expect(text).toContain("implementation details need no approval");
  });

  it("keeps adjacent skill boundaries explicit", async () => {
    const pairs = [
      ["ast-grep", "unlike LSP"],
      ["compress", "unlike caveman"],
      ["debugging", "unlike programming"],
      ["lsp", "unlike lsp-setup"],
      ["plan-review", "unlike plan"],
      ["refactor", "unlike remove-ai-slops"],
      ["security-research", "unlike debugging"],
    ] as const;
    for (const [name, boundary] of pairs) {
      expect((await skill(name)).toLowerCase()).toContain(boundary.toLowerCase());
    }
  });
});
