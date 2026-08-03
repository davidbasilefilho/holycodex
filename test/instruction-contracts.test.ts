import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { handleGitBashMcpRequest } from "../packages/git-bash-mcp/src/mcp.ts";
import { handleLspMcpRequest } from "../packages/lsp-core/src/mcp.ts";

const root = join(import.meta.dirname, "..");
const pluginRoot = join(root, "packages", "plugin", "plugin");
const skillsRoot = join(pluginRoot, "skills");

async function skill(name: string): Promise<string> {
  return readFile(join(skillsRoot, name, "SKILL.md"), "utf8");
}

function expectOrder(text: string, patterns: readonly RegExp[]): void {
  let previous = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    expect(match, `missing ordered contract: ${String(pattern)}`).not.toBeNull();
    const current = match?.index ?? -1;
    expect(current).toBeGreaterThan(previous);
    previous = current;
  }
}

async function byteLength(paths: readonly string[]): Promise<number> {
  const files = await Promise.all(paths.map((path) => readFile(path)));
  return files.reduce((sum, file) => sum + file.byteLength, 0);
}

describe("instruction workflow contracts", () => {
  it("keeps routed skill metadata precise and bounded", async () => {
    const names = (await readdir(skillsRoot)).sort();
    expect(names).toHaveLength(15);
    const texts = await Promise.all(names.map(skill));
    for (const text of texts) {
      const description = text.match(/^description: (.*)$/m)?.[1] ?? "";
      expect(description).toMatch(/^Use (?:when|for) /);
      expect(description).toMatch(/do not/);
      expect(description).toMatch(/Produces|Applies/);
      expect(text.length).toBeLessThanOrEqual(4_000);
    }
  });

  it("bounds every runtime-loaded instruction and MCP descriptor surface", async () => {
    const skillPaths = (await readdir(skillsRoot, { recursive: true }))
      .filter((path) => path.endsWith(".md") && !path.endsWith("ATTRIBUTION.md"))
      .map((path) => join(skillsRoot, path));
    const agentsRoot = join(pluginRoot, "agents");
    const agentPaths = (await readdir(agentsRoot))
      .filter((path) => path.endsWith(".toml"))
      .map((path) => join(agentsRoot, path));
    const skills = await byteLength(skillPaths);
    const coreAndAgents = await byteLength([
      ...agentPaths,
      join(root, "packages", "cli", "src", "core-instructions.ts"),
    ]);
    const gitBashInitialize = await handleGitBashMcpRequest({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    const gitBashTools = await handleGitBashMcpRequest(
      { jsonrpc: "2.0", id: "tools", method: "tools/list" },
      { platform: "win32", exists: () => true, where: () => ["C:\\Git\\bin\\bash.exe"] },
    );
    const lspTools = await handleLspMcpRequest({
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
    });
    const gitBash =
      Buffer.byteLength(JSON.stringify(gitBashInitialize)) +
      Buffer.byteLength(JSON.stringify(gitBashTools));
    const lsp = Buffer.byteLength(JSON.stringify(lspTools));

    expect(skills).toBeLessThanOrEqual(30_000);
    expect(coreAndAgents).toBeLessThanOrEqual(10_250);
    expect(gitBash).toBeLessThanOrEqual(1_400);
    expect(lsp).toBeLessThanOrEqual(3_300);
    expect(skills + coreAndAgents + gitBash + lsp).toBeLessThanOrEqual(44_500);
  });

  it("pins delegation and browser/computer routing fixtures", async () => {
    const fixtures = JSON.parse(
      await readFile(join(root, "test", "fixtures", "routing-policy.json"), "utf8"),
    ) as Array<{ id: string; route: string; before?: string; after?: string }>;
    const expected = new Map([
      ["three-source-comparison", "librarian"],
      ["multi-file-facts", "explorer"],
      ["version-research", "librarian"],
      ["isolated-multi-file-write", "worker"],
      ["atomic-one-file-local-work", "local"],
      ["coupled-architecture-local-work", "local"],
      ["authenticated-project-setting", "browser-control"],
      ["authenticated-deployment-inspection", "browser-control"],
      ["native-windows-application", "computer-use"],
      ["public-documentation-research", "librarian"],
      ["destructive-dashboard-action", "browser-control"],
    ]);
    expect(fixtures.map(({ id }) => id)).toEqual([...expected.keys()]);
    for (const fixture of fixtures)
      expect(fixture.route, fixture.id).toBe(expected.get(fixture.id));
    expect(fixtures.find(({ id }) => id === "destructive-dashboard-action")).toMatchObject({
      before: "approval",
      after: "browser-control",
    });

    const core = await readFile(
      join(root, "packages", "cli", "src", "core-instructions.ts"),
      "utf8",
    );
    expect(core).toMatch(/default browser[\s\S]*authenticated/);
    expect(core).toMatch(/public research as a substitute for authenticated control/);
    expect(core).toMatch(/Root itself defaults to browser control for browser UI/);
    expect(core).toMatch(/and to computer use for non-browser desktop\/native Windows UI/);
    expect(core).toMatch(/Never delegate browser or computer control/);
    expect(core).toMatch(/manual-click instructions, shell-as-GUI/);
    expect(core).toMatch(/Inspect tools before declaring capability unavailable/);
    expect(core).toMatch(/Observe results before claiming authenticated success/);
    expect(core).toMatch(/Codex Security plugin skills[\s\S]*security reviews\/audits\/scans/);
    expect(core).toMatch(/ask when policy requires before material, destructive, irreversible/);
    expect(core).toMatch(/Explorer is repo-read-only, Librarian research-only/);
    expect(core).toMatch(/Worker cannot alter dashboards\/accounts\/permissions\/external state/);
  });

  it("preserves clarification, delegation, and specialist boundaries", async () => {
    const core = await readFile(
      join(root, "packages", "cli", "src", "core-instructions.ts"),
      "utf8",
    );
    expect(core).toMatch(
      /delegate facts, ask material decisions, state\/use safe reversible defaults/,
    );
    expect(core).toMatch(/target, scope, behavior, architecture, proof, visible direction/);
    expect(core).toMatch(/request_user_input[\s\S]*exclusive choices[\s\S]*no timeout/);
    expect(core).toMatch(/Explorer is mandatory before a second separable repo search/);
    expect(core).toMatch(/Librarian before a second external source/);
    expect(core).toMatch(/Worker for fixed isolated work beyond one file/);
    expect(core).toMatch(/Default to delegation: delegate the first clear unit/);
    expect(core).toMatch(/No delegation quota:[\s\S]*never manufacture work to fill capacity/);
    expect(core).toMatch(/never assign overlapping writes/);
    expect(core).toMatch(/Never delegate review, overlap writes/);
    for (const name of ["explorer", "librarian", "worker"])
      expect(await readFile(join(pluginRoot, "agents", `${name}.toml`), "utf8")).toMatch(
        /question-ready blocker:[\s\S]*resume condition/,
      );
    expect(await readFile(join(pluginRoot, "agents", "explorer.toml"), "utf8")).toMatch(
      /Never edit\/install, research externally/,
    );
    expect(await readFile(join(pluginRoot, "agents", "librarian.toml"), "utf8")).toMatch(
      /Never inspect repo beyond supplied context, implement, write externally/,
    );
    expect(await readFile(join(pluginRoot, "agents", "worker.toml"), "utf8")).toMatch(
      /Never discover architecture, integrate\/verify finally/,
    );
  });

  it("orders planning, one plan review, approval, and implementation", async () => {
    const plan = await skill("plan");
    expectOrder(plan, [
      /Load `plan`/,
      /draft complete initial plan/,
      /Only then load `plan-review`/,
      /Use `plan-review` once/,
      /ask approval/,
      /After approval, implement/,
    ]);
    expect(plan).toMatch(/never implement before/);
    expect(plan).toMatch(/Stop after approval; no repeated review/);
    const review = await skill("plan-review");
    expect(review).toMatch(/If incomplete, return to `plan`/);
    expect(review).toMatch(/No reviewer, evidence folder, second review, or implementation/);
  });

  it("keeps adversarial plan-review coverage semantic", async () => {
    const review = await skill("plan-review");
    const fixtures = JSON.parse(
      await readFile(join(root, "test", "fixtures", "plan-review.json"), "utf8"),
    ) as Array<{ expected: string[] }>;
    const contracts: Record<string, RegExp> = {
      "missing-requirement": /Requirement ledger[\s\S]*Map each material requirement/,
      "non-executable-plan": /Each step names surface\/outcome, prerequisites\/owner/,
      "fabricated-fact": /invent nothing/i,
      "unsupported-api": /APIs, commands\/scripts, dependencies/,
      "wrong-order": /Execution graph[\s\S]*prerequisites, order/,
      "missing-rollback": /failure\/rollback/,
      "weak-proof": /exact checks\/results[\s\S]*Reject vague/,
      "stale-generated-output": /stale output/,
      "missing-package-proof": /package\/publication results/,
      "behavior-changing-cleanup": /behavior-changing refactors/,
      "missing-failure-path": /missing edges\/failures/,
      "write-overlap": /write overlap/,
      "unsafe-parallelism": /unsafe parallelism/,
      "compatibility-risk": /compatibility\/data loss/,
      "windows-shell": /Windows Git Bash/,
      "missing-attribution": /licensing\/attribution/,
      "continues-past-goal": /post-goal/,
      "frontend-routing": /Build Web Apps `frontend-app-builder`/,
      "frontend-accessibility": /frontend accessibility\/motion/,
    };
    for (const fixture of fixtures)
      for (const issue of fixture.expected) {
        const contract = contracts[issue];
        if (contract === undefined) throw new Error(`Missing contract for ${issue}.`);
        expect(review, issue).toMatch(contract);
      }
    expectOrder(review, [
      /Requirement ledger/,
      /Fact audit/,
      /Execution graph/,
      /Adversarial audit/,
      /Proof matrix/,
      /Scope audit/,
      /Result/,
    ]);
  });

  it("routes one Root-owned final code review with full audit contracts", async () => {
    const programming = await skill("programming");
    const review = await skill("code-review");
    const core = await readFile(
      join(root, "packages", "cli", "src", "core-instructions.ts"),
      "utf8",
    );
    expect(programming.match(/loads `code-review` exactly once/g)).toHaveLength(1);
    expect(core.match(/loads `code-review` exactly once/g)).toHaveLength(1);
    expect(review).toMatch(/Never delegate review/);
    expect(review).toMatch(/Worker proof is never final/);
    expectOrder(review, [
      /Load request, approved plan/,
      /Capture Git status, working\/staged diffs, untracked files/,
      /Map requirements\/plan to implementation\/proof/,
      /Inspect changes\/consumers/,
      /Fix all in-scope issues/,
      /Discover native commands/,
      /Fix implementation failures; rerun affected checks/,
      /Inspect final diff\/status/,
      /Continue only with material progress/,
      /Report scope, repairs/,
    ]);
    for (const contract of [
      /APIs, types, state\/data, config, manifests, migrations/,
      /generated files, docs, tests\/fixtures, packaging\/publication/,
      /format, lint, strict types, targeted\/proportional tests, build/,
      /Separate new from preexisting\/external failures with evidence/,
      /no arbitrary loop count/,
      /exact checks\/results, skips\/reasons/,
    ])
      expect(review).toMatch(contract);
  });

  it("preserves implementation, compression, cleanup, UI, and Windows contracts", async () => {
    const programming = await skill("programming");
    expect(programming).toMatch(/For defects\/unproved behavior, add public-seam test/);
    expect(programming).toMatch(/One behavior, one implementation/);
    expect(programming).toMatch(/shared root seam once/);
    expect(programming).toMatch(/under 200 LOC[\s\S]*split above 250/);

    const compress = await skill("compress");
    expect(compress).toMatch(/facts, distinctions, exact values\/order, constraints, exceptions/);
    expect(compress).toMatch(/no loss, weaker ban, invented claim/);
    expect(compress).toMatch(/`compress` owns meaning; `caveman` owns voice/);

    const cleanup = await skill("remove-slop");
    expectOrder(cleanup, [
      /Explicit user scope wins/,
      /Lock behavior/,
      /Remove only proven/,
      /Keep boundaries/,
      /Work safest first/,
      /Run targeted proof/,
    ]);
    expect(cleanup).toMatch(/stop if unverified/);
    expect(cleanup).toMatch(/main`, `master`, `trunk`, or `develop/);
    expect(cleanup).toMatch(/THIRD-PARTY-NOTICES.md/);

    const plan = await skill("plan");
    const review = await skill("plan-review");
    const worker = await readFile(join(pluginRoot, "agents", "worker.toml"), "utf8");
    for (const text of [plan, review, worker]) {
      expect(text).toContain("Build Web Apps");
      expect(text).toContain("`frontend-app-builder`");
    }
    expect(plan).toMatch(/concept generation and separate design approval/);
    expect(review).toMatch(/concept\/design approval/);
    expect(worker).toMatch(/concept, approval, implementation, visual verification/);

    const windowsPolicy = await readFile(
      join(root, "packages", "cli", "src", "catalog.ts"),
      "utf8",
    );
    expect(windowsPolicy).toMatch(/mcp__git_bash__run[\s\S]*every shell command/);
    expect(windowsPolicy).toMatch(/Never fall back to PowerShell or cmd/);
  });

  it("babysits CI/CD through fixes, retriggers, and artifact inspection", async () => {
    const babysit = await skill("babysit-ci");
    expect(babysit).toMatch(
      /^description: Use when a push, tag, dispatch\/rerun, release, or deployment triggers CI\/CD/m,
    );
    expect(babysit).toMatch(/Watch relevant runs to terminal state/);
    expect(babysit).toMatch(/never retry an unchanged deterministic failure/);
    expect(babysit).toMatch(/fix push, transient rerun, workflow dispatch/);
    expect(babysit).toMatch(
      /Ask immediately before every push, publication\/deployment, or tag creation/,
    );
    expect(babysit).toMatch(/broad requests and prior approval do not waive/);
    expect(babysit).toMatch(/For binary deliverables only[\s\S]*inspect integrity/);
    expect(babysit).toMatch(/Never manually inspect registry outputs/);
    expect(babysit).toMatch(/terminal-green required CI\/CD/);
  });
});
