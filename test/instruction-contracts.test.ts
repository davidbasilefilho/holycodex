import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pluginRoot = join(root, "packages", "plugin", "plugin");

async function skill(name: string): Promise<string> {
  return readFile(join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
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
    const names = (await readdir(join(pluginRoot, "skills"))).sort();
    expect(names).toHaveLength(15);
    const texts = await Promise.all(names.map(skill));
    for (const text of texts) {
      const description = text.match(/^description: (.*)$/m)?.[1] ?? "";
      expect(description).toMatch(/^Use when /);
      expect(description).toMatch(/do not/);
      expect(description).toMatch(/Produces|Applies|Creates/);
      expect(text.length).toBeLessThanOrEqual(5_000);
    }
    expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(50_000);
  });

  it("bounds the complete routed instruction surface", async () => {
    const skillsRoot = join(pluginRoot, "skills");
    const references = (await readdir(skillsRoot, { recursive: true }))
      .filter((path) => path.endsWith(".md") && !path.endsWith("ATTRIBUTION.md"))
      .map((path) => readFile(join(skillsRoot, path), "utf8"));
    const agentsRoot = join(pluginRoot, "agents");
    const agents = (await readdir(agentsRoot))
      .filter((path) => path.endsWith(".toml"))
      .map((path) => readFile(join(agentsRoot, path), "utf8"));
    const texts = await Promise.all([
      ...references,
      ...agents,
      readFile(join(root, "packages", "cli", "src", "core-instructions.ts"), "utf8"),
    ]);
    // Allows explicit mandatory tool-routing contracts with measured headroom.
    expect(texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(
      100_000,
    );
  });

  it("routes representative requests without adjacent skills or wasteful delegation", async () => {
    const cases = [
      {
        request: "Fix one known parser line in a named function",
        expected: [
          ["debugging", /crash, wrong result/],
          ["programming", /changes code or its manifests/],
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
        expected: [["programming", /changes code or its manifests/]],
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

  it("pins capability-routing fixtures as prompt contracts", async () => {
    const fixtures = JSON.parse(
      await readFile(join(root, "test", "fixtures", "routing-policy.json"), "utf8"),
    ) as Array<{ id: string; route: string; before?: string; then?: string }>;
    const core = await readFile(
      join(root, "packages", "cli", "src", "core-instructions.ts"),
      "utf8",
    );
    const expectedRoutes = new Map([
      ["three-source-comparison", "librarian"],
      ["multi-file-facts", "explorer"],
      ["version-research", "librarian"],
      ["isolated-multi-file-write", "worker"],
      ["atomic-one-file-local-work", "local"],
      ["coupled-architecture-local-work", "local"],
    ]);
    expect(fixtures.map((fixture) => fixture.id)).toEqual([...expectedRoutes.keys()]);
    for (const fixture of fixtures)
      expect(fixture.route, fixture.id).toBe(expectedRoutes.get(fixture.id));
    const threeSourceComparison = fixtures.find(
      (fixture) => fixture.id === "three-source-comparison",
    );
    expect(threeSourceComparison?.before).toBe("root-source-ingestion");
    expect(threeSourceComparison?.then).toBe("worker-after-decisions");
    expect(core).toContain("Delegate long, context-heavy, separable, or easier work");
    expect(core).toContain(
      "Explorer is mandatory before a second separable repository read/search",
    );
    expect(core).toContain("any multi-file or symbol fact pass");
    expect(core).toContain(
      "Librarian is mandatory before a second external source or multi-source, version, or date research",
    );
    expect(core).toContain("Worker is mandatory for fixed isolated implementation beyond one file");
    expect(core).toContain("Keep work local only when atomic, coupled, architecturally unresolved");
    expect(core).toContain("Never use a reviewer agent, allow overlapping write ownership");
    expect(core).toContain("estimate exact monetary or token cost");
  });

  it("pins clarification fixtures and specialist blocker returns as prompt contracts", async () => {
    const fixtures = JSON.parse(
      await readFile(join(root, "test", "fixtures", "clarification-policy.json"), "utf8"),
    ) as Array<{ id: string; classification: string; action: string }>;
    const core = await readFile(
      join(root, "packages", "cli", "src", "core-instructions.ts"),
      "utf8",
    );
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "missing-product-behavior",
      "destructive-action",
      "safe-default",
      "discoverable-fact",
      "specialist-blocker",
    ]);
    expect(fixtures.map((fixture) => fixture.action)).toEqual([
      "ask",
      "ask",
      "state-and-proceed",
      "delegate",
      "return-question-ready-blocker",
    ]);
    expect(core).toContain("delegate discoverable facts; ask the user for a material decision");
    expect(core).toContain("state and proceed with a safe reversible default");
    expect(core).toContain("target, scope, behavior, architecture, proof, visible direction");
    expect(core).toContain(
      "compatibility, privacy, security, authority, or an external or destructive effect",
    );
    expect(core).toContain("For a material blocker, use `request_user_input` when available");
    expect(core).toContain("Do not repeat a question or ask for discoverable facts");
    for (const name of ["explorer", "librarian", "worker"])
      expect(await readFile(join(pluginRoot, "agents", `${name}.toml`), "utf8")).toContain(
        "return a question-ready blocker",
      );
  });

  it("orders planning, one review, approval, and stop", async () => {
    const text = await skill("plan");
    expect(text).toContain("do not use for multiple obvious steps");
    expectOrder(text, [
      "Load `plan`",
      "Write the complete initial plan",
      "Only after the initial plan exists, load `plan-review`",
      "Use `plan-review` once",
      "ask for approval",
      "After approval, implement the approved plan",
    ]);
    expect(text).toContain("Do not implement before approval.");
    expect(text).toContain("Stop after approval; no repeated review.");
    expect(text).not.toContain("define-goal");

    const review = await skill("plan-review");
    expect(review).toContain("If no initial plan exists, stop");
    expect(review).toContain("One pass:");
    expect(review).toContain(
      "No reviewer agent, evidence folder, second review loop, or implementation.",
    );
  });

  it("covers realistic adversarial plan-review failures", async () => {
    const review = await skill("plan-review");
    const fixtures = JSON.parse(
      await readFile(join(root, "test", "fixtures", "plan-review.json"), "utf8"),
    ) as Array<{ expected: string[] }>;
    const contracts: Record<string, RegExp> = {
      "missing-requirement": /Map every material requirement/,
      "unsupported-assumption": /unsupported assumptions/,
      "wrong-scope": /wrong scope\/order/,
      "dependency-cycle": /circular dependencies/,
      "write-overlap": /overlapping writes/,
      "unsafe-parallelism": /unsafe parallelism/,
      "unresolved-decision": /unresolved product choices/,
      "compatibility-risk": /compatibility/,
      "windows-shell": /Windows Git Bash/,
      "frontend-accessibility": /frontend accessibility\/motion/,
      "weak-proof": /vague criteria, unverifiable outcomes/,
      "missing-package": /generated\/package/,
      "token-waste": /context-heavy delegation/,
      "behavior-changing-cleanup": /behavior-changing cleanup/,
      "missing-attribution": /attribution\/license/,
      "continues-past-goal": /continuing beyond real goal/,
    };
    for (const fixture of fixtures) {
      for (const issue of fixture.expected) {
        const contract = contracts[issue];
        expect(contract, `unknown fixture issue: ${issue}`).toBeDefined();
        if (contract !== undefined)
          expect(review, `uncovered fixture issue: ${issue}`).toMatch(contract);
      }
    }
    expect(review).toContain(
      "Block architecture or user decisions; label lesser repairs suggestions.",
    );
    expect(review).toContain("Rank findings by impact before revising.");
    expect(review).toContain("Revise once");
  });

  it("validates semantic compression examples", async () => {
    const cases = JSON.parse(
      await readFile(join(root, "test", "fixtures", "compress.json"), "utf8"),
    ) as Array<{ source: string; compressed: string; preserve: string[]; absent: string[] }>;
    for (const item of cases) {
      expect(item.compressed.length).toBeLessThan(item.source.length);
      expect(item.compressed).toMatch(/[.!?]$/);
      for (const exact of item.preserve) expect(item.compressed).toContain(exact);
      for (const waste of item.absent) expect(item.compressed.toLowerCase()).not.toContain(waste);
    }
  });

  it("validates remove-slop behavior-lock fixtures", async () => {
    const cases = JSON.parse(
      await readFile(join(root, "test", "fixtures", "remove-slop.json"), "utf8"),
    ) as Array<{ file: string; generated: boolean; proof: boolean; expected: string }>;
    for (const item of cases) {
      const actual = item.generated ? "exclude" : item.proof ? "eligible" : "stop";
      expect(actual, item.file).toBe(item.expected);
    }
    const contract = await skill("remove-slop");
    expect(contract).toContain("generated");
    expect(contract).toContain("stop if unverified");
  });

  it("distinguishes defect, new behavior, covered, and nonbehavior testing", async () => {
    const text = await skill("programming");
    expect(text).toContain("Defect: add a public-seam regression test first");
    expect(text).toContain("explicit test-first work or defined new behavior lacking proof");
    expect(text).toContain("Existing tests may lock small covered changes");
    expect(text).toContain(
      "Do not force red-green for prose, configuration-only work, trivial mechanical edits",
    );
  });

  it("requires one reusable implementation for shared behavior", async () => {
    const text = await skill("programming");
    expect(text).toContain("One behavior, one implementation");
    expect(text).toContain("Search before writing; reuse or extend the existing implementation");
    expect(text).toContain("Never copy logic or maintain parallel policy variants");
    expect(text).toContain("Put shared behavior at its smallest stable common ownership seam");
    expect(text).toContain("Extract real repetition");
    expect(text).toContain("stable domain abstraction");
    expect(text).toContain("cohesive state transition");
    expect(text).toContain("Prefer pure functions below 200 LOC");
    expect(text).toContain("split above 250 when responsibilities separate cleanly");
    expect(text).toContain("Prefer a named input object above three independent parameters");
  });

  it("routes UI work through installed Frontend App Builder workflows", async () => {
    const plan = await skill("plan");
    const review = await skill("plan-review");
    const worker = await readFile(join(pluginRoot, "agents", "worker.toml"), "utf8");
    const rootInstructions = await readFile(
      join(root, "packages", "cli", "src", "core-instructions.ts"),
      "utf8",
    );
    for (const text of [rootInstructions, worker, plan, review]) {
      expect(text).toContain("Build Web Apps");
      expect(text).toContain("`frontend-app-builder`");
    }
    expect(plan).toContain("concept-generation and design-approval workflow");
    expect(plan).toContain("Read-only UI audits bypass this gate");
    expect(review).toContain("concept and design-approval workflow");
    expect(review).toContain("return it to `plan`");
    expect(review).toContain("Read-only UI audits are exempt");
  });

  it("keeps adjacent skill boundaries explicit", async () => {
    const pairs = [
      ["ast-grep", "unlike LSP"],
      ["compress", "unlike caveman"],
      ["debugging", "unlike programming"],
      ["lsp", "unlike lsp-setup"],
      ["plan-review", "unlike plan"],
      ["refactor", "unlike remove-slop"],
      ["security-research", "unlike debugging"],
    ] as const;
    for (const [name, boundary] of pairs) {
      expect((await skill(name)).toLowerCase()).toContain(boundary.toLowerCase());
    }
  });

  it("defines semantic compression before caveman rendering", async () => {
    const text = await skill("compress");
    for (const requirement of [
      "repetition, filler, hedging, ceremony, inflated wording",
      "distinctions, exact values/order, constraints, exceptions",
      "permissions, gates, warnings, evidence/citations, stops",
      "exact names/strings, code/commands/paths/APIs/errors/numbers/links",
      "weaker prohibition",
      "omitted exception, warning, validation, or stop",
      "Both: compress, then render lite unless explicit",
    ])
      expect(text).toContain(requirement);
    expect(text).toContain("`compress` owns semantic compression.");
    expect(text).toContain("`caveman` owns persistent voice and stronger modes.");
  });

  it("locks remove-slop scope, behavior, exceptions, and proof", async () => {
    const text = await skill("remove-slop");
    expectOrder(text, [
      "Explicit user scope is authoritative",
      "Lock observable behavior",
      "Remove only proven",
      "Keep boundary",
      "Work safest first",
      "Run targeted proof",
    ]);
    for (const rule of [
      "never expand scope",
      "stop if unverified",
      "Skip uncertain changes",
      "Ask before module splits",
      "never copy unsupported OpenCode mechanics",
      "THIRD-PARTY-NOTICES.md",
      "detected repository default branch",
      "current branch upstream",
      "`main`, `master`, `trunk`, or `develop`",
      "stop and ask for explicit scope",
    ])
      expect(text).toContain(rule);
  });

  it("covers deterministic remove-slop base-selection cases", async () => {
    const text = await skill("remove-slop");
    const cases = JSON.parse(
      await readFile(join(root, "test", "fixtures", "remove-slop-branches.json"), "utf8"),
    ) as Array<{ case: string; expected: string }>;
    expect(cases.map((item) => item.case)).toEqual([
      "main",
      "master",
      "remote-only-default",
      "tracking-branch",
      "explicit-scope",
      "unresolved-base",
    ]);
    for (const item of cases) expect(text).toContain(item.expected);
  });
});
