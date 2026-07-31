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
    expect(review).toContain("If no complete plan exists, stop");
    expect(review).toContain(
      "No reviewer agent, evidence folder, second review loop, or implementation.",
    );
  });

  it("covers executable adversarial plan-review failures", async () => {
    const review = await skill("plan-review");
    const fixtures = JSON.parse(
      await readFile(join(root, "test", "fixtures", "plan-review.json"), "utf8"),
    ) as Array<{ name: string; plan: string; expected: string[] }>;
    const contracts: Record<string, RegExp> = {
      "missing-requirement": /Requirement ledger[\s\S]*Map each to an exact plan step/,
      "non-executable-plan":
        /Every corrected step names target surface, intended outcome, prerequisites and owner/,
      "fabricated-fact": /Invent no path, symbol, command, capability, or assumption/,
      "unsupported-api": /APIs, commands, scripts, dependencies/,
      "wrong-order": /Execution graph[\s\S]*prerequisites, order/,
      "missing-rollback": /failure or rollback/,
      "weak-proof": /exact check and expected result[\s\S]*Reject vague criteria/,
      "stale-generated-output": /stale outputs/,
      "missing-package-proof": /package result, publication result/,
      "behavior-changing-cleanup": /behavior-changing refactors/,
      "missing-failure-path": /which edge or failure is missing/,
      "write-overlap": /overlapping writes/,
      "unsafe-parallelism": /unsafe parallelism/,
      "compatibility-risk": /compatibility, data loss/,
      "windows-shell": /Windows Git Bash/,
      "missing-attribution": /attribution and licensing/,
      "continues-past-goal": /post-goal tasks/,
      "frontend-routing": /Build Web Apps `frontend-app-builder`/,
      "frontend-accessibility": /frontend accessibility and motion/,
    };
    expect(fixtures).toHaveLength(13);
    for (const fixture of fixtures) {
      expect(fixture.plan, fixture.name).not.toHaveLength(0);
      for (const issue of fixture.expected) {
        const contract = contracts[issue];
        expect(contract, `unknown fixture issue: ${issue}`).toBeDefined();
        if (contract !== undefined)
          expect(review, `uncovered fixture issue: ${fixture.name}: ${issue}`).toMatch(contract);
      }
    }
    expectOrder(review, [
      "Requirement ledger",
      "Fact audit",
      "Execution graph",
      "Adversarial audit",
      "Proof matrix",
      "Scope audit",
      "Result",
    ]);
    const result = review.slice(review.indexOf("7. **Result.**"));
    expectOrder(result, [
      "ranked findings",
      "corrected executable plan",
      "unresolved material decisions",
      "residual risks",
      "ready-for-approval status",
    ]);
  });

  it("routes one Root-owned final code review after implementation", async () => {
    const programming = await skill("programming");
    const review = await skill("code-review");
    const core = await readFile(
      join(root, "packages", "cli", "src", "core-instructions.ts"),
      "utf8",
    );
    const worker = await readFile(join(pluginRoot, "agents", "worker.toml"), "utf8");

    expect(programming.match(/load `code-review` exactly once/g)).toHaveLength(1);
    expectOrder(programming, [
      "This skill owns implementation.",
      "load `code-review` exactly once before the final response",
      "`code-review` owns the final scope audit",
      "Then hand off once to `code-review`",
    ]);
    expect(core.match(/load `code-review` exactly once/g)).toHaveLength(1);
    expect(review).toContain("Root owns scope comparison, integration, final judgment");
    expect(review).toContain("Never create or delegate a reviewer.");
    expect(worker).toContain(
      "Do not use for discovery, product decisions, integration, or final verification",
    );
    expect(review).toContain("Worker verification is never final.");
    expect(review).toContain("`plan-review` repairs a complete plan before approval");
    expect(review).toContain("existing or supplied code");
    expect(review).toContain("Prose-only or docs-only changes");
    expect(review).not.toMatch(/^\*\*.* MODE ACTIVATED\*\*$/m);
  });

  it("orders complete code-review scope, repair, proof, and final inspection", async () => {
    const review = await skill("code-review");
    expectOrder(review, [
      "Load the full task request, any approved plan",
      "Git status, working-tree diff, staged diff, and untracked files",
      "explicit review of unchanged or supplied code",
      "Compare every requirement and approved plan item",
      "Inspect changed code and affected callers",
      "Fix every in-scope issue instead of merely reporting it",
      "Discover native commands from manifests",
      "Run relevant checks in order",
      "rerun every affected check",
      "inspect final Git diff and status",
      "Continue only while making material progress",
      "Report reviewed scope",
    ]);
    for (const contract of [
      "public APIs, types, data and state flows, configuration, manifests, migrations",
      "generated files, docs, tests, fixtures, packaging, and publication surfaces",
      "formatter, linter, strict type checker, targeted tests, proportional broader tests, build",
      "package or publication checks, and generated consistency",
      "catch formatter effects, generated changes, staging differences, and scope drift",
      "There is no arbitrary loop count.",
      "Distinguish new failures from preexisting or external failures with evidence.",
      "skipped checks with reasons",
      "exact commands and checks with results",
      "residual risks, and final status",
    ])
      expect(review).toContain(contract);
  });

  it("covers adversarial code-review failures as workflow contracts", async () => {
    const review = await skill("code-review");
    const fixtures = JSON.parse(
      await readFile(join(root, "test", "fixtures", "code-review.json"), "utf8"),
    ) as Array<{ name: string; state: string; expected: string[] }>;
    const contracts: Record<string, RegExp> = {
      "affected-caller": /affected callers, consumers/,
      "complete-git-scope":
        /complete changed scope with Git status, working-tree diff, staged diff/,
      "untracked-files": /untracked files/,
      "test-quality": /test quality/,
      "api-compatibility": /public APIs[\s\S]*compatibility and migrations/,
      "formatter-diff": /formatter effects/,
      "final-git-scope": /inspect final Git diff and status/,
      "generated-output": /generated consistency/,
      "ordered-checks": /formatter, linter, strict type checker, targeted tests/,
      "repair-failures": /Fix failures caused by the implementation/,
      "rerun-checks": /rerun every affected check/,
      "scope-cleanliness": /Remove accidents, debug artifacts, stale outputs, unrelated edits/,
      "failure-classification": /Distinguish new failures from preexisting or external failures/,
      "requirement-comparison": /Compare every requirement and approved plan item/,
      "explicit-review-surface": /exact surface plus affected callers, consumers, and contracts/,
      "native-command-discovery":
        /Discover native commands from manifests, workspace configuration/,
      "bounded-progress": /Continue only while making material progress/,
    };
    expect(fixtures).toHaveLength(16);
    for (const fixture of fixtures) {
      expect(fixture.state, fixture.name).not.toHaveLength(0);
      for (const issue of fixture.expected) {
        const contract = contracts[issue];
        expect(contract, `unknown fixture issue: ${issue}`).toBeDefined();
        if (contract !== undefined)
          expect(review, `uncovered fixture issue: ${fixture.name}: ${issue}`).toMatch(contract);
      }
    }
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

  it("routes available UI work through Frontend App Builder workflows", async () => {
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
    expect(plan).toContain("enable Build Web Apps through Codex");
    expect(plan).toContain("do not block planning solely on absence");
    expect(plan).toContain("Read-only UI audits bypass this gate");
    expect(review).toContain("concept and design-approval workflow");
    expect(review).toContain("enable Build Web Apps through Codex");
    expect(review).toContain("do not block review solely on absence");
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
