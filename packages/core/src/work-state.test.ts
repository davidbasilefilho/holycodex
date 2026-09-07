// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { decode, encode } from "@toon-format/toon";

import { IntentStore, readRepositorySnapshot, type RepositorySnapshot } from "./work-state.ts";

const execFileAsync = promisify(execFile);

function snapshot(
  root: string,
  head = "a".repeat(40),
  changedPaths: readonly string[] = [],
): RepositorySnapshot {
  return {
    root,
    gitCommonDir: join(root, ".git"),
    head,
    changedPaths,
    statusDigest: "b".repeat(64),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "holycodex-work-state-"));
  let current = snapshot(root);
  const store = new IntentStore(root, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    repositorySnapshot: async () => current,
  });
  return {
    root,
    store,
    setSnapshot: (value: RepositorySnapshot) => {
      current = value;
    },
  };
}

async function git(root: string, ...args: readonly string[]): Promise<string> {
  return (
    await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
    })
  ).stdout.trim();
}

describe("IntentStore", () => {
  test("limits Assignment ownership to canonical specialist role/task pairs", async () => {
    const { store } = await fixture();
    const intent = await store.createIntent({
      title: "Owners",
      goal: "Persist work",
      acceptanceCriteria: ["readable"],
    });
    await expect(
      store.createAssignment(
        intent.id,
        {
          objective: "Root work",
          owner: { role: "Root" as never, task: "implementation" },
          scope: ["packages/core"],
          acceptanceCriteria: ["proof"],
        },
        intent.revision,
      ),
    ).rejects.toMatchObject({ code: "schema_invalid" });
    await expect(
      store.createAssignment(
        intent.id,
        {
          objective: "Unknown work",
          owner: { role: "Worker", task: "research" },
          scope: ["packages/core"],
          acceptanceCriteria: ["proof"],
        },
        intent.revision,
      ),
    ).rejects.toMatchObject({ code: "schema_invalid" });
  });

  test("round-trips validated TOON and discovers the selected Intent deterministically", async () => {
    const { root, store } = await fixture();
    const intent = await store.createIntent({
      title: "Round trip",
      goal: "Persist work",
      acceptanceCriteria: ["readable"],
    });
    const reread = await store.readIntent(intent.id);
    expect(reread).toEqual(intent);
    expect(await store.currentIntent()).toEqual(intent);
    const directory = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    expect(
      decode(await readFile(join(root, ".holycodex", directory, "intent.toon"), "utf8"), {
        strict: true,
      }),
    ).toMatchObject({ id: intent.id });
  });

  test("rejects malformed persisted TOON and migrates the supported legacy schema", async () => {
    const { root, store } = await fixture();
    const intent = await store.createIntent({
      title: "Malformed",
      goal: "Persist work",
      acceptanceCriteria: ["readable"],
    });
    const directory = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    const path = join(root, ".holycodex", directory, "intent.toon");
    await writeFile(path, "not: [valid\n", "utf8");
    await expect(store.readIntent(intent.id)).rejects.toMatchObject({ code: "schema_invalid" });

    await writeFile(
      path,
      encode({
        schema_version: "holycodex-intent-0",
        id: intent.id,
        slug: intent.slug,
        title: intent.title,
        goal: intent.goal,
        acceptance_criteria: intent.acceptance_criteria,
        state: "scoping",
        revision: 1,
        baseline: intent.baseline,
        created_at: intent.created_at,
        updated_at: intent.updated_at,
      }) + "\n",
      "utf8",
    );
    const migrated = await store.readIntent(intent.id);
    expect(migrated.schema_version).toBe("holycodex-intent-1");
    expect(migrated.toon_compatibility).toBe("toon-4");
  });

  test("rejects symlinked repository-local state and current pointers", async () => {
    const { root, store } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "holycodex-work-state-outside-"));
    await symlink(outside, join(root, ".holycodex"), "dir");
    await expect(store.listIntents()).rejects.toMatchObject({ code: "schema_invalid" });

    const safe = await fixture();
    const intent = await safe.store.createIntent({
      title: "Pointer security",
      goal: "Keep work state local",
      acceptanceCriteria: ["reject escapes"],
    });
    const current = join(safe.root, ".holycodex", "current");
    await unlink(current);
    await symlink(join(outside, "current"), current, "file");
    await expect(safe.store.currentIntent()).rejects.toMatchObject({ code: "schema_invalid" });
    expect(intent.id).toMatch(/^intent-/u);
  });

  test("rejects symlinked Assignment directories and mismatched Assignment provenance", async () => {
    const { root, store } = await fixture();
    const intent = await store.createIntent({
      title: "Assignment paths",
      goal: "Keep bounded state inside the Intent",
      acceptanceCriteria: ["safe"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Bounded work",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const directory = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    const assignments = join(root, ".holycodex", directory, "assignments");
    const outside = await mkdtemp(join(tmpdir(), "holycodex-assignment-outside-"));
    await rm(assignments, { recursive: true, force: true });
    await symlink(outside, assignments, "dir");
    await expect(store.readAssignment(intent.id, assignment.id)).rejects.toMatchObject({
      code: "schema_invalid",
    });

    const safe = await fixture();
    const safeIntent = await safe.store.createIntent({
      title: "Assignment identity",
      goal: "Keep bounded state attributable",
      acceptanceCriteria: ["safe"],
    });
    const safeAssignment = await safe.store.createAssignment(
      safeIntent.id,
      {
        objective: "Bounded work",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      safeIntent.revision,
    );
    const safeDirectory = (await readdir(join(safe.root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    await writeFile(
      join(safe.root, ".holycodex", safeDirectory, "assignments", `${safeAssignment.id}.toon`),
      encode({ ...safeAssignment, intent_id: "intent-other" }) + "\n",
      "utf8",
    );
    await expect(safe.store.readAssignment(safeIntent.id, safeAssignment.id)).rejects.toMatchObject(
      {
        code: "schema_invalid",
      },
    );
    await expect(safe.store.listAssignments(safeIntent.id)).rejects.toMatchObject({
      code: "schema_invalid",
    });
  });

  test("cleans interrupted temporary writes and rejects concurrent stale mutations", async () => {
    const { root, store } = await fixture();
    const intent = await store.createIntent({
      title: "Concurrent",
      goal: "Persist work",
      acceptanceCriteria: ["readable"],
    });
    const directory = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    await writeFile(
      join(root, ".holycodex", directory, ".holycodex-write-crash.tmp"),
      "partial",
      "utf8",
    );
    await writeFile(
      join(root, ".holycodex", directory, "assignments", ".holycodex-write-nested.tmp"),
      "partial",
      "utf8",
    );
    expect(await store.recover()).toEqual(
      expect.arrayContaining([
        `${directory}/.holycodex-write-crash.tmp`,
        `${directory}/assignments/.holycodex-write-nested.tmp`,
      ]),
    );
    const results = await Promise.allSettled([
      store.transitionIntent(intent.id, "ready", intent.revision),
      store.transitionIntent(intent.id, "ready", intent.revision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code,
    ).toBe("stale_write");
  });

  test("reclaims a lock whose recorded owner process is gone", async () => {
    const { root, store } = await fixture();
    const intent = await store.createIntent({
      title: "Dead lock",
      goal: "Recover work state",
      acceptanceCriteria: ["readable"],
    });
    const lockPath = join(root, ".holycodex", ".intent-store");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, ".owner"),
      JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: "dead-owner" }),
      "utf8",
    );

    await expect(store.selectCurrent(intent.id)).resolves.toEqual(intent);
    await expect(readdir(join(root, ".holycodex"))).resolves.not.toContain(".intent-store");
  });

  test("enforces readiness, blockers, review re-entry, abandonment, and completion predicates", async () => {
    const { store } = await fixture();
    let intent = await store.createIntent({
      title: "Lifecycle",
      goal: "Persist work",
      acceptanceCriteria: ["readable"],
      planRequired: true,
    });
    await expect(store.transitionIntent(intent.id, "ready", intent.revision)).rejects.toMatchObject(
      { code: "not_ready" },
    );
    intent = await store
      .revisePlan(intent.id, { approach: "delegate" }, intent.revision)
      .then((result) => result.intent);
    intent = await store.transitionIntent(intent.id, "ready", intent.revision);
    intent = await store.transitionIntent(intent.id, "executing", intent.revision);
    intent = await store.transitionIntent(
      intent.id,
      "blocked",
      intent.revision,
      "Need Root choice",
    );
    await expect(
      store.transitionIntent(intent.id, "executing", intent.revision),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    intent = await store.recordIntentEvidence(intent.id, intent.revision, { clearBlockers: true });
    intent = await store.transitionIntent(intent.id, "executing", intent.revision);
    intent = await store.transitionIntent(intent.id, "verifying", intent.revision);
    await expect(
      store.transitionIntent(intent.id, "reviewing", intent.revision),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      verification: "passed",
      evidence: [{ kind: "behavior", value: "lifecycle predicates", result: "passed" }],
    });
    intent = await store.transitionIntent(intent.id, "reviewing", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, { review: "rejected" });
    expect(intent.state).toBe("executing");
    const refusal = await store.completeIntent(intent.id, intent.revision);
    expect(refusal).toEqual({
      completed: false,
      reasons: [
        "intent_not_reviewing",
        "assignment_required",
        "review_unresolved",
        "acceptance_criteria_unmet",
        "root_readiness_missing",
      ],
    });
    intent = await store.abandonIntent(intent.id, intent.revision);
    expect(intent.state).toBe("abandoned");
  });

  test("archives immutable plan revisions and records bounded Assignment invocations/evidence", async () => {
    const { store, root, setSnapshot } = await fixture();
    let intent = await store.createIntent({
      title: "Assignments",
      goal: "Persist work",
      acceptanceCriteria: ["readable"],
    });
    let revised = await store.revisePlan(intent.id, { approach: "first" }, intent.revision);
    intent = revised.intent;
    revised = await store.revisePlan(
      intent.id,
      { approach: "second" },
      intent.revision,
      revised.plan.revision,
    );
    intent = revised.intent;
    expect(revised.archived).toBe("plan.old-001.toon");
    await expect(store.readPlan(intent.id)).resolves.toEqual(revised.plan);
    const directory = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    expect(await readdir(join(root, ".holycodex", directory))).toContain("plan.old-001.toon");
    await expect(
      store.revisePlan(
        intent.id,
        { approach: "stale" },
        intent.revision - 1,
        revised.plan.revision,
      ),
    ).rejects.toMatchObject({ code: "stale_write" });

    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Bounded work",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    let running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    setSnapshot(snapshot(root, "a".repeat(40), ["packages/core/src/work-state.ts"]));
    const result = await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
      outcome: "completed",
      summary: "implemented",
      evidence: [
        { kind: "changed_path", value: "packages/core/src/work-state.ts", result: "observed" },
      ],
    });
    expect(result.assignment.status).toBe("completed");
    expect(result.assignment.invocations).toHaveLength(1);
    expect(result.assignment.evidence[0]?.kind).toBe("changed_path");
    running = await store.readAssignment(intent.id, assignment.id);
    expect(running.status).toBe("completed");
  });

  test("requires delegated proof before allowing completion", async () => {
    const { store } = await fixture();
    let intent = await store.createIntent({
      title: "Complete",
      goal: "Persist work",
      acceptanceCriteria: ["readable"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Delegate the work",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    intent = (
      await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        outcome: "completed",
        summary: "delegated proof",
      })
    ).intent;
    intent = await store.transitionIntent(intent.id, "ready", intent.revision);
    intent = await store.transitionIntent(intent.id, "executing", intent.revision);
    intent = await store.transitionIntent(intent.id, "verifying", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      verification: "passed",
      evidence: [{ kind: "check", value: "focused lifecycle test", result: "passed" }],
    });
    intent = await store.transitionIntent(intent.id, "reviewing", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      review: "accepted",
      acceptanceMet: true,
      rootReadiness: true,
    });
    const completed = await store.completeIntent(intent.id, intent.revision);
    expect("completed" in completed ? completed.completed : completed.state === "complete").toBe(
      true,
    );
  });

  test("requires meaningful verification evidence and correlates Assignment results to starts", async () => {
    const { store } = await fixture();
    let intent = await store.createIntent({
      title: "Evidence and correlation",
      goal: "Require attributable execution proof",
      acceptanceCriteria: ["safe"],
    });
    intent = await store.transitionIntent(intent.id, "ready", intent.revision);
    intent = await store.transitionIntent(intent.id, "executing", intent.revision);
    intent = await store.transitionIntent(intent.id, "verifying", intent.revision);
    await expect(
      store.recordIntentEvidence(intent.id, intent.revision, { verification: "passed" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      verification: "passed",
      evidence: [{ kind: "behavior", value: "observable result", result: "observed" }],
    });

    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Bounded execution",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    expect(running.status).toBe("executing");
    expect(running.active_invocation_id).toBe("invocation-001");
    await expect(
      store.startAssignment(intent.id, assignment.id, running.revision),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        invocationId: "invocation-999",
        outcome: "completed",
        summary: "mismatched result",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    const result = await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
      outcome: "completed",
      summary: "correlated result",
    });
    expect(result.assignment.status).toBe("completed");
    expect(result.assignment.active_invocation_id).toBeUndefined();
    expect(result.assignment.invocations[0]?.id).toBe("invocation-001");
  });

  test("supports Root scope reconciliation for an unfinished Assignment", async () => {
    const { store, root, setSnapshot } = await fixture();
    const intent = await store.createIntent({
      title: "Scope reconciliation",
      goal: "Correct a bounded path after implementation expands its proof surface",
      acceptanceCriteria: ["safe"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Implement and prove a state seam",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core/src/work-state.ts"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    const revised = await store.reviseAssignmentScope(
      intent.id,
      assignment.id,
      { scope: ["packages/core/src/work-state.ts", "packages/core/src/work-state.test.ts"] },
      running.revision,
    );
    expect(revised.status).toBe("executing");
    expect(revised.active_invocation_id).toBe(running.active_invocation_id);
    setSnapshot(snapshot(root, "a".repeat(40), ["packages/core/src/work-state.test.ts"]));
    const result = await store.recordAssignmentResult(intent.id, assignment.id, revised.revision, {
      outcome: "completed",
      summary: "Scope correction recorded",
      evidence: [
        {
          kind: "changed_path",
          value: "packages/core/src/work-state.test.ts",
          result: "observed",
        },
      ],
    });
    expect(result.assignment.status).toBe("completed");
  });

  test("attributes concurrent active Assignment paths without accepting unrelated drift", async () => {
    const { store, root, setSnapshot } = await fixture();
    const intent = await store.createIntent({
      title: "Concurrent assignments",
      goal: "Keep independent work attributable",
      acceptanceCriteria: ["safe"],
    });
    const first = await store.createAssignment(
      intent.id,
      {
        objective: "First independent seam",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/first"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const second = await store.createAssignment(
      intent.id,
      {
        objective: "Second independent seam",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/second"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const firstRunning = await store.startAssignment(intent.id, first.id, first.revision);
    const secondRunning = await store.startAssignment(intent.id, second.id, second.revision);
    setSnapshot(snapshot(root, "a".repeat(40), ["packages/second/result.ts"]));
    const firstResult = await store.recordAssignmentResult(
      intent.id,
      first.id,
      firstRunning.revision,
      { outcome: "completed", summary: "First seam complete" },
    );
    expect(firstResult.assignment.status).toBe("completed");

    setSnapshot(
      snapshot(root, "a".repeat(40), ["packages/second/result.ts", "packages/unrelated.ts"]),
    );
    await expect(
      store.recordAssignmentResult(intent.id, second.id, secondRunning.revision, {
        outcome: "completed",
        summary: "Second seam complete",
        evidence: [
          { kind: "changed_path", value: "packages/second/result.ts", result: "observed" },
        ],
      }),
    ).rejects.toMatchObject({ code: "repository_drift" });
  });

  test("preserves the leading status column when reading modified paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-status-"));
    await execFileAsync("git", ["init", "-q", root]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "AGENTS.md"), "initial\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "AGENTS.md"]);
    await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
    await writeFile(join(root, "AGENTS.md"), "modified\n", "utf8");
    await expect(readRepositorySnapshot(root)).resolves.toMatchObject({
      changedPaths: ["AGENTS.md"],
    });
  });

  test("records exact Root VCS integration before an operations Assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-vcs-integration-"));
    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await writeFile(join(root, ".gitignore"), ".holycodex/\n", "utf8");
    await writeFile(join(root, "implementation.txt"), "before\n", "utf8");
    await git(root, "add", ".gitignore", "implementation.txt");
    await git(root, "commit", "-q", "-m", "initial");
    const parent = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "implementation.txt"), "after\n", "utf8");
    const store = new IntentStore(root, { repositorySnapshot: () => readRepositorySnapshot(root) });
    let intent = await store.createIntent({
      title: "VCS integration",
      goal: "Record the reviewed commit before operations work",
      acceptanceCriteria: ["exact commit"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Implement the reviewed change",
        owner: { role: "Worker", task: "implementation" },
        scope: ["implementation.txt"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    intent = (
      await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        outcome: "completed",
        summary: "Implementation complete",
        evidence: [{ kind: "changed_path", value: "implementation.txt", result: "observed" }],
      })
    ).intent;
    intent = await store.transitionIntent(intent.id, "ready", intent.revision);
    intent = await store.transitionIntent(intent.id, "executing", intent.revision);
    intent = await store.transitionIntent(intent.id, "verifying", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      verification: "passed",
      evidence: [{ kind: "behavior", value: "reviewed implementation", result: "passed" }],
    });
    intent = await store.transitionIntent(intent.id, "reviewing", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      review: "accepted",
    });
    await expect(
      store.createAssignment(
        intent.id,
        {
          objective: "Observe CI before integration",
          owner: { role: "Worker", task: "operations" },
          scope: ["."],
          acceptanceCriteria: ["exact SHA evidence"],
        },
        intent.revision,
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    await git(root, "add", "implementation.txt");
    await git(root, "commit", "-q", "-m", "implement reviewed change");
    const commit = await git(root, "rev-parse", "HEAD");
    expect(commit).not.toBe(parent);
    const integrated = await store.recordVcsIntegration(intent.id, intent.revision, { commit });
    expect(integrated.baseline.expected_head).toBe(commit);
    expect(integrated.baseline.expected_changes).toEqual([]);
    expect(integrated.evidence.at(-1)?.value).toContain(commit);
    const operations = await store.createAssignment(
      intent.id,
      {
        objective: "Observe exact integrated SHA",
        owner: { role: "Worker", task: "operations" },
        scope: ["."],
        acceptanceCriteria: ["exact SHA evidence"],
      },
      integrated.revision,
    );
    expect(operations.status).toBe("pending");
    const operationsRunning = await store.startAssignment(
      integrated.id,
      operations.id,
      operations.revision,
    );
    const operationsResult = await store.recordAssignmentResult(
      integrated.id,
      operations.id,
      operationsRunning.revision,
      {
        outcome: "completed",
        summary: "Exact integrated SHA observed",
        evidence: [{ kind: "ci", value: `observed ${commit}`, result: "passed" }],
      },
    );
    expect(operationsResult.intent.state).toBe("reviewing");
    expect(operationsResult.intent.verification.status).toBe("passed");
    expect(operationsResult.intent.review.status).toBe("accepted");
    expect(operationsResult.intent.baseline.integrated_commit).toBe(commit);
    const readyToComplete = await store.recordIntentEvidence(
      integrated.id,
      operationsResult.intent.revision,
      { acceptanceMet: true, rootReadiness: true },
    );
    const completed = await store.completeIntent(integrated.id, readyToComplete.revision);
    expect("completed" in completed ? completed.completed : completed.state === "complete").toBe(
      true,
    );
  });

  test("returns failed operations to executing while preserving the integrated commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-operations-failure-"));
    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await writeFile(join(root, ".gitignore"), ".holycodex/\n", "utf8");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-q", "-m", "initial");
    const store = new IntentStore(root, { repositorySnapshot: () => readRepositorySnapshot(root) });
    let intent = await store.createIntent({
      title: "Operations recovery",
      goal: "Return failed exact-SHA observation to repair",
      acceptanceCriteria: ["recoverable"],
    });
    intent = await store.transitionIntent(intent.id, "ready", intent.revision);
    intent = await store.transitionIntent(intent.id, "executing", intent.revision);
    intent = await store.transitionIntent(intent.id, "verifying", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      verification: "passed",
      evidence: [{ kind: "behavior", value: "clean exact-SHA baseline", result: "passed" }],
    });
    intent = await store.transitionIntent(intent.id, "reviewing", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, { review: "accepted" });
    await git(root, "commit", "--allow-empty", "-q", "-m", "integrated");
    const integrated = await store.recordVcsIntegration(intent.id, intent.revision, {
      commit: await git(root, "rev-parse", "HEAD"),
    });
    const operations = await store.createAssignment(
      integrated.id,
      {
        objective: "Observe the integrated commit",
        owner: { role: "Worker", task: "operations" },
        scope: ["."],
        acceptanceCriteria: ["report failure"],
      },
      integrated.revision,
    );
    const running = await store.startAssignment(integrated.id, operations.id, operations.revision);
    const failed = await store.recordAssignmentResult(
      integrated.id,
      operations.id,
      running.revision,
      { outcome: "failed", summary: "CI observation failed" },
    );
    expect(failed.intent.state).toBe("executing");
    expect(failed.intent.verification.status).toBe("missing");
    expect(failed.intent.review.status).toBe("missing");
    expect(failed.intent.acceptance_met).toBe(false);
    expect(failed.intent.root_readiness).toBe(false);
    expect(failed.intent.baseline.integrated_commit).toBe(integrated.baseline.integrated_commit);
    const retry = await store.startAssignment(
      integrated.id,
      operations.id,
      failed.assignment.revision,
    );
    const recovered = await store.recordAssignmentResult(
      integrated.id,
      operations.id,
      retry.revision,
      { outcome: "completed", summary: "CI observation recovered" },
    );
    expect(recovered.intent.state).toBe("executing");
    expect(recovered.intent.verification.status).toBe("missing");
    expect(recovered.intent.review.status).toBe("missing");
  });

  test("accepts declared task evolution while rejecting unexplained repository drift", async () => {
    const { store, root, setSnapshot } = await fixture();
    const intent = await store.createIntent({
      title: "Drift",
      goal: "Persist work",
      acceptanceCriteria: ["readable"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Observe expected evolution",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    setSnapshot(snapshot(root, "c".repeat(40)));
    await expect(
      store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        outcome: "completed",
        summary: "missing declaration",
      }),
    ).rejects.toMatchObject({ code: "repository_drift" });
    await expect(
      store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        outcome: "completed",
        summary: "unobserved declaration",
        evidence: [{ kind: "changed_path", value: "packages/core/src/work-state.ts" }],
      }),
    ).rejects.toMatchObject({ code: "repository_drift" });
    setSnapshot(snapshot(root, "c".repeat(40), ["packages/core/src/work-state.ts"]));
    const result = await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
      outcome: "completed",
      summary: "declared task evolution",
      evidence: [{ kind: "changed_path", value: "packages/core/src/work-state.ts" }],
    });
    expect(result.assignment.status).toBe("completed");
  });

  test("rejects assignment evidence outside scope and repository identity drift", async () => {
    const { store, root, setSnapshot } = await fixture();
    const intent = await store.createIntent({
      title: "Boundaries",
      goal: "Keep assignments scoped",
      acceptanceCriteria: ["safe"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Stay within the assigned package",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    await expect(
      store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        outcome: "completed",
        summary: "out of bounds",
        evidence: [{ kind: "changed_path", value: "packages/cli/src/index.ts" }],
      }),
    ).rejects.toMatchObject({ code: "repository_drift" });

    setSnapshot({
      ...snapshot(root),
      root: `${root}-different`,
      gitCommonDir: `${root}-different/.git`,
    });
    await expect(
      store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        outcome: "completed",
        summary: "identity changed",
      }),
    ).rejects.toMatchObject({ code: "repository_drift" });
  });
});
