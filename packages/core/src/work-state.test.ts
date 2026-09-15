// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { decode, encode } from "@toon-format/toon";

import { IntentStore, readRepositorySnapshot, type RepositorySnapshot } from "./work-state.ts";

const execFileAsync = promisify(execFile);
// Windows directory junctions are reparse-point symlinks and do not require
// the elevated privilege that native directory/file symlinks require.
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

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

  test("falls back only when the current Intent selection is genuinely absent", async () => {
    const { root, store } = await fixture();
    const intent = await store.createIntent({
      title: "Absent selection",
      goal: "Retain deterministic fallback",
      acceptanceCriteria: ["readable"],
    });
    await unlink(join(root, ".holycodex", "current"));
    await expect(store.currentIntent()).resolves.toEqual(intent);
  });

  test("rejects existing empty or whitespace-only current pointers", async () => {
    for (const pointer of ["", " \t\n"]) {
      const { root, store } = await fixture();
      await store.createIntent({
        title: "Invalid selection",
        goal: "Reject malformed current pointers",
        acceptanceCriteria: ["readable"],
      });
      await writeFile(join(root, ".holycodex", "current"), pointer, "utf8");
      await expect(store.currentIntent()).rejects.toMatchObject({ code: "schema_invalid" });
    }
  });

  test("reports a missing selected Intent record instead of falling back", async () => {
    const { root, store } = await fixture();
    const selected = await store.createIntent({
      title: "Missing selected record",
      goal: "Preserve pointer corruption evidence",
      acceptanceCriteria: ["readable"],
    });
    await store.createIntent({
      title: "Other active Intent",
      goal: "Remain available for explicit selection",
      acceptanceCriteria: ["readable"],
    });
    await store.selectCurrent(selected.id);
    const directory = (await readFile(join(root, ".holycodex", "current"), "utf8")).trim();
    const record = join(root, ".holycodex", directory, "intent.toon");
    await unlink(record);
    await expect(store.currentIntent()).rejects.toMatchObject({
      code: "not_found",
      details: { path: record },
    });
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
    await symlink(outside, join(root, ".holycodex"), directorySymlinkType);
    await expect(store.listIntents()).rejects.toMatchObject({ code: "schema_invalid" });

    const safe = await fixture();
    const intent = await safe.store.createIntent({
      title: "Pointer security",
      goal: "Keep work state local",
      acceptanceCriteria: ["reject escapes"],
    });
    const current = join(safe.root, ".holycodex", "current");
    await unlink(current);
    await symlink(join(outside, "current"), current, directorySymlinkType);
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
    await symlink(outside, assignments, directorySymlinkType);
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

  test("requires typed Context7 evidence only for applicable Librarian results", async () => {
    const { store } = await fixture();
    let intent = await store.createIntent({
      title: "Context7 evidence",
      goal: "Keep current technical research attributable",
      acceptanceCriteria: ["evidence"],
    });
    const missing = await store.createAssignment(
      intent.id,
      {
        objective: "Resolve the current React API documentation",
        owner: { role: "Librarian", task: "lookup" },
        scope: ["research"],
        acceptanceCriteria: ["Return source evidence"],
      },
      intent.revision,
    );
    const missingRunning = await store.startAssignment(intent.id, missing.id, missing.revision);
    await expect(
      store.recordAssignmentResult(intent.id, missing.id, missingRunning.revision, {
        outcome: "completed",
        summary: "Missing typed proof",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: { assignment_id: missing.id, required_evidence: "context7" },
    });

    const evidenceStates = [
      "used",
      "no_coverage",
      "unavailable",
      "auth_or_quota_failure",
      "source_conflict",
    ] as const;
    for (const state of evidenceStates) {
      const assignment = await store.createAssignment(
        intent.id,
        {
          id: `context7-${state.replaceAll("_", "-")}`,
          objective: "Resolve the current React API documentation",
          owner: { role: "Librarian", task: "research" },
          scope: ["research"],
          acceptanceCriteria: ["Return source evidence"],
        },
        intent.revision,
      );
      const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
      const result = await store.recordAssignmentResult(
        intent.id,
        assignment.id,
        running.revision,
        {
          outcome: "completed",
          summary: `Recorded ${state} proof`,
          context7: { state, evidence: [`Context7 ${state} evidence`] },
        },
      );
      expect(result.assignment.invocations[0]?.context7).toEqual({
        state,
        evidence: [`Context7 ${state} evidence`],
      });
      intent = result.intent;
    }

    const unrelated = await store.createAssignment(
      intent.id,
      {
        objective: "Find a historical fact about an author",
        owner: { role: "Librarian", task: "lookup" },
        scope: ["research"],
        acceptanceCriteria: ["Return the fact"],
      },
      intent.revision,
    );
    const unrelatedRunning = await store.startAssignment(
      intent.id,
      unrelated.id,
      unrelated.revision,
    );
    const unrelatedResult = await store.recordAssignmentResult(
      intent.id,
      unrelated.id,
      unrelatedRunning.revision,
      { outcome: "completed", summary: "Historical fact recorded" },
    );
    expect(unrelatedResult.assignment.invocations[0]?.context7).toBeUndefined();
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

  test("requires the active invocation capability for specialist terminal results", async () => {
    const { store } = await fixture();
    const intent = await store.createIntent({
      title: "Invocation capability",
      goal: "Keep specialist result writes attributable to their active invocation",
      acceptanceCriteria: ["proof"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Record an attributable specialist result",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    const invocationId = running.active_invocation_id;
    const capability = running.active_invocation_capability;
    expect(invocationId).toBe("invocation-001");
    expect(capability).toMatch(/^[a-f0-9]{64}$/u);
    if (invocationId === undefined || capability === undefined)
      throw new Error("startAssignment did not issue invocation authorization");

    await expect(
      store.recordSpecialistAssignmentResult(intent.id, assignment.id, running.revision, {
        invocationId,
        outcome: "completed",
        summary: "Missing capability",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.recordSpecialistAssignmentResult(intent.id, assignment.id, running.revision, {
        invocationId,
        capability: "f".repeat(64),
        outcome: "completed",
        summary: "Wrong capability",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    const result = await store.recordSpecialistAssignmentResult(
      intent.id,
      assignment.id,
      running.revision,
      {
        invocationId,
        capability,
        outcome: "completed",
        summary: "Capability-bound result",
      },
    );
    expect(result.assignment.status).toBe("completed");
    expect(result.assignment.active_invocation_id).toBeUndefined();
    expect(result.assignment.active_invocation_capability).toBeUndefined();
  });

  test("atomically supersedes one unfinished related Assignment and removes its blocker", async () => {
    const { store, root } = await fixture();
    const intent = await store.createIntent({
      title: "Assignment supersession",
      goal: "Replace a bounded unfinished task without losing its provenance",
      acceptanceCriteria: ["proof"],
    });
    const predecessor = await store.createAssignment(
      intent.id,
      {
        id: "predecessor",
        objective: "Implement the first lifecycle seam",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core/src/work-state.ts"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const replacement = await store.createAssignment(
      intent.id,
      {
        id: "replacement",
        objective: "Implement the corrected lifecycle seam",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core/src/work-state.ts", "packages/core/src/work-state.test.ts"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );

    const result = await store.supersedeAssignment(
      intent.id,
      predecessor.id,
      predecessor.revision,
      {
        replacementId: replacement.id,
        replacementRevision: replacement.revision,
        reason: "The implementation seam moved with its proof surface.",
        provenance: "Root scope reconciliation",
      },
    );

    expect(result.assignment.status).toBe("superseded");
    expect(result.assignment.superseded_by).toBe(replacement.id);
    expect(result.assignment.supersession_reason).toBe(
      "The implementation seam moved with its proof surface.",
    );
    expect(result.assignment.supersession_provenance).toBe("Root scope reconciliation");
    expect(result.replacement.status).toBe("pending");
    expect(result.replacement.supersedes).toBe(predecessor.id);
    expect(result.replacement.revision).toBe(replacement.revision + 1);
    expect(result.intent.revision).toBe(intent.revision + 1);
    expect(result.intent.evidence.at(-1)?.value).toContain(
      `${predecessor.id} superseded by ${replacement.id}`,
    );
    expect(await store.listAssignments(intent.id)).toEqual([result.assignment, result.replacement]);
    const directory = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    expect(await readdir(join(root, ".holycodex", directory))).not.toContain(
      ".holycodex-transaction.toon",
    );
    await expect(
      store.startAssignment(intent.id, result.assignment.id, result.assignment.revision),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      store.reviseAssignmentScope(
        intent.id,
        result.assignment.id,
        { scope: result.assignment.scope },
        result.assignment.revision,
      ),
    ).rejects.toMatchObject({ code: "invalid_transition" });
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

  test("allows concurrent paths within the current Assignment scope without misattribution", async () => {
    const { store, root, setSnapshot } = await fixture();
    const intent = await store.createIntent({
      title: "Overlapping assignments",
      goal: "Persist independent work without shared evidence bookkeeping",
      acceptanceCriteria: ["safe"],
    });
    const primary = await store.createAssignment(
      intent.id,
      {
        objective: "Record the primary package change",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const parallel = await store.createAssignment(
      intent.id,
      {
        objective: "Record the nested package change",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const primaryRunning = await store.startAssignment(intent.id, primary.id, primary.revision);
    const parallelRunning = await store.startAssignment(intent.id, parallel.id, parallel.revision);
    const primaryPath = "packages/primary/result.ts";
    const parallelPath = "packages/core/parallel/result.ts";
    setSnapshot(snapshot(root, "a".repeat(40), [primaryPath, parallelPath, "docs/unrelated.ts"]));

    await expect(
      store.recordAssignmentResult(intent.id, primary.id, primaryRunning.revision, {
        outcome: "completed",
        summary: "Reject unrelated drift",
        evidence: [{ kind: "changed_path", value: primaryPath, result: "observed" }],
      }),
    ).rejects.toMatchObject({
      code: "repository_drift",
      details: { unexpected_paths: ["docs/unrelated.ts"] },
    });

    setSnapshot(snapshot(root, "a".repeat(40), [primaryPath, parallelPath]));

    const result = await store.recordAssignmentResult(
      intent.id,
      primary.id,
      primaryRunning.revision,
      {
        outcome: "completed",
        summary: "Primary package change recorded",
        evidence: [{ kind: "changed_path", value: primaryPath, result: "observed" }],
      },
    );

    expect(result.assignment.status).toBe("completed");
    expect(result.assignment.invocations[0]?.evidence).toEqual([
      { kind: "changed_path", value: primaryPath, result: "observed" },
    ]);
    await expect(store.readAssignment(intent.id, parallel.id)).resolves.toMatchObject({
      revision: parallelRunning.revision,
      status: "executing",
      invocations: [],
    });
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
    const legacyStatus = (
      await execFileAsync(
        "git",
        ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" },
      )
    ).stdout.trimEnd();
    await expect(readRepositorySnapshot(root)).resolves.toMatchObject({
      changedPaths: ["AGENTS.md"],
      statusDigest: createHash("sha256").update(legacyStatus).digest("hex"),
    });
  });

  test("reads NUL-delimited status paths for portable names and rename destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-status-nul-"));
    await execFileAsync("git", ["init", "-q", root]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    const renamedFrom = "old path é.txt";
    const renamedTo = "new path 中.txt";
    const modified = "modified path ü.txt";
    const untracked = "untracked path.txt";
    await writeFile(join(root, renamedFrom), "rename me\n", "utf8");
    await writeFile(join(root, modified), "before\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
    await execFileAsync("git", ["-C", root, "mv", renamedFrom, renamedTo]);
    await writeFile(join(root, modified), "after\n", "utf8");
    await writeFile(join(root, untracked), "new\n", "utf8");

    await expect(readRepositorySnapshot(root)).resolves.toMatchObject({
      changedPaths: [modified, renamedTo, untracked].sort(),
    });
  });

  test.skipIf(process.platform === "win32")(
    "reads NUL-delimited status paths with POSIX control and quote names",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "holycodex-status-nul-posix-"));
      await execFileAsync("git", ["init", "-q", root]);
      await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
      await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
      const renamedFrom = 'old\tpath "é.txt';
      const renamedTo = 'new -> path "é.txt';
      const modified = 'modified\tpath\n"ü.txt';
      const untracked = 'untracked -> path "中.txt';
      await writeFile(join(root, renamedFrom), "rename me\n", "utf8");
      await writeFile(join(root, modified), "before\n", "utf8");
      await execFileAsync("git", ["-C", root, "add", "."]);
      await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
      await execFileAsync("git", ["-C", root, "mv", renamedFrom, renamedTo]);
      await writeFile(join(root, modified), "after\n", "utf8");
      await writeFile(join(root, untracked), "new\n", "utf8");

      await expect(readRepositorySnapshot(root)).resolves.toMatchObject({
        changedPaths: [modified, renamedTo, untracked].sort(),
      });
    },
  );

  test("accepts old C-quoted Unicode and space paths in a persisted baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-legacy-baseline-"));
    await execFileAsync("git", ["init", "-q", root]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", root, "config", "core.quotePath", "true"]);
    const special = "\uFEFFspecial é path.txt";
    await writeFile(join(root, ".gitignore"), ".holycodex/\n", "utf8");
    await writeFile(join(root, special), "before\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
    await writeFile(join(root, special), "after\n", "utf8");
    const legacyStatus = (
      await execFileAsync(
        "git",
        ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" },
      )
    ).stdout.trimEnd();
    const legacyPath = legacyStatus.slice(3);
    expect(legacyPath).not.toBe(special);
    const store = new IntentStore(root, { repositorySnapshot: () => readRepositorySnapshot(root) });
    const intent = await store.createIntent({
      title: "Legacy baseline",
      goal: "Read old path encodings exactly",
      acceptanceCriteria: ["readable"],
    });
    const directory = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    const path = join(root, ".holycodex", directory, "intent.toon");
    const persisted = decode(await readFile(path, "utf8"), { strict: true }) as {
      baseline: { expected_changes: string[] };
    };
    persisted.baseline.expected_changes = [legacyPath];
    await writeFile(path, `${encode(persisted)}\n`, "utf8");

    const ready = await store.transitionIntent(intent.id, "ready", intent.revision);
    await expect(
      store.transitionIntent(intent.id, "executing", ready.revision),
    ).resolves.toMatchObject({
      state: "executing",
    });
  });

  test.skipIf(process.platform === "win32")(
    "accepts old C-quoted POSIX control and quote paths in a persisted baseline",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "holycodex-legacy-baseline-posix-"));
      await execFileAsync("git", ["init", "-q", root]);
      await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
      await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
      const special = 'special\tpath\n"é.txt';
      await writeFile(join(root, ".gitignore"), ".holycodex/\n", "utf8");
      await writeFile(join(root, special), "before\n", "utf8");
      await execFileAsync("git", ["-C", root, "add", "."]);
      await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
      await writeFile(join(root, special), "after\n", "utf8");
      const legacyStatus = (
        await execFileAsync(
          "git",
          ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
          { encoding: "utf8" },
        )
      ).stdout.trimEnd();
      const legacyPath = legacyStatus.slice(3);
      expect(legacyPath).not.toBe(special);
      const store = new IntentStore(root, {
        repositorySnapshot: () => readRepositorySnapshot(root),
      });
      const intent = await store.createIntent({
        title: "Legacy POSIX baseline",
        goal: "Read old POSIX path encodings exactly",
        acceptanceCriteria: ["readable"],
      });
      const directory = (await readdir(join(root, ".holycodex"))).find(
        (entry) => entry !== "current",
      )!;
      const path = join(root, ".holycodex", directory, "intent.toon");
      const persisted = decode(await readFile(path, "utf8"), { strict: true }) as {
        baseline: { expected_changes: string[] };
      };
      persisted.baseline.expected_changes = [legacyPath];
      await writeFile(path, `${encode(persisted)}\n`, "utf8");

      const ready = await store.transitionIntent(intent.id, "ready", intent.revision);
      await expect(
        store.transitionIntent(intent.id, "executing", ready.revision),
      ).resolves.toMatchObject({
        state: "executing",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "integrates commits with POSIX special paths exactly",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "holycodex-special-commit-"));
      await execFileAsync("git", ["init", "-q", root]);
      await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
      await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
      const special = ' leading "é ->\tpath\n.txt ';
      await writeFile(join(root, ".gitignore"), ".holycodex/\n", "utf8");
      await writeFile(join(root, special), "before\n", "utf8");
      await execFileAsync("git", ["-C", root, "add", "."]);
      await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
      const parent = (
        await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
      ).stdout.trim();
      const store = new IntentStore(root, {
        repositorySnapshot: () => readRepositorySnapshot(root),
      });
      let intent = await store.createIntent({
        title: "Special commit path",
        goal: "Integrate a reviewed special path exactly",
        acceptanceCriteria: ["exact path"],
      });
      const assignment = await store.createAssignment(
        intent.id,
        {
          objective: "Modify the special path",
          owner: { role: "Worker", task: "implementation" },
          scope: [special],
          acceptanceCriteria: ["proof"],
        },
        intent.revision,
      );
      const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
      await writeFile(join(root, special), "after\n", "utf8");
      intent = (
        await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
          outcome: "completed",
          summary: "Special path modified",
          evidence: [{ kind: "changed_path", value: special, result: "observed" }],
        })
      ).intent;
      intent = await store.transitionIntent(intent.id, "ready", intent.revision);
      intent = await store.transitionIntent(intent.id, "executing", intent.revision);
      intent = await store.transitionIntent(intent.id, "verifying", intent.revision);
      intent = await store.recordIntentEvidence(intent.id, intent.revision, {
        verification: "passed",
        evidence: [{ kind: "check", value: "special path integration proof", result: "passed" }],
      });
      intent = await store.transitionIntent(intent.id, "reviewing", intent.revision);
      intent = await store.recordIntentEvidence(intent.id, intent.revision, {
        review: "accepted",
      });
      await execFileAsync("git", ["-C", root, "add", "--", special]);
      await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "special path"]);
      const commit = (
        await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
      ).stdout.trim();
      expect(commit).not.toBe(parent);
      await expect(
        store.recordVcsIntegration(intent.id, intent.revision, { commit }),
      ).resolves.toMatchObject({
        baseline: { expected_head: commit, expected_changes: [] },
      });
    },
  );

  test("records exact Root VCS integration for portable Unicode and space paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-vcs-integration-"));
    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    const implementationPath = "implementation é path.txt";
    await writeFile(join(root, ".gitignore"), ".holycodex/\n", "utf8");
    await writeFile(join(root, implementationPath), "before\n", "utf8");
    await git(root, "add", ".gitignore", implementationPath);
    await git(root, "commit", "-q", "-m", "initial");
    const parent = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, implementationPath), "after\n", "utf8");
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
        scope: [implementationPath],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    intent = (
      await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        outcome: "completed",
        summary: "Implementation complete",
        evidence: [{ kind: "changed_path", value: implementationPath, result: "observed" }],
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
    await git(root, "add", implementationPath);
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

  test("admits scoped dirty ingress and bounded scope expansion across start and result", async () => {
    const { store, root, setSnapshot } = await fixture();
    const intent = await store.createIntent({
      title: "Scoped ingress",
      goal: "Allow declared task files to enter the lifecycle",
      acceptanceCriteria: ["bounded"],
    });
    const changedPath = "packages/core/src/new-task.ts";
    const siblingTest = "packages/core/src/new-task.test.ts";
    setSnapshot({
      ...snapshot(root, "a".repeat(40), [changedPath]),
      statusDigest: "c".repeat(64),
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Implement the declared task",
        owner: { role: "Worker", task: "implementation" },
        scope: [changedPath],
        acceptanceCriteria: ["proof"],
      },
      intent.revision,
    );
    await expect(
      store.createAssignment(
        intent.id,
        {
          objective: "Escape the declared component",
          owner: { role: "Worker", task: "implementation" },
          scope: ["packages/agent/src/index.ts"],
          acceptanceCriteria: ["proof"],
        },
        intent.revision,
      ),
    ).rejects.toMatchObject({ code: "repository_drift" });

    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision, {
      scope: [changedPath, siblingTest],
    });
    expect(running.scope).toEqual([changedPath, siblingTest].sort());
    await expect(
      store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
        outcome: "completed",
        summary: "Declared task complete",
        scope: [changedPath],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const result = await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
      outcome: "completed",
      summary: "Declared task complete",
      scope: [changedPath, siblingTest],
      evidence: [{ kind: "changed_path", value: changedPath, result: "observed" }],
    });
    expect(result.assignment.scope).toEqual([changedPath, siblingTest].sort());
    expect(result.assignment.status).toBe("completed");
  });

  test("preserves Root gates for a successful read-only Assignment result", async () => {
    const { store, root } = await fixture();
    let intent = await store.createIntent({
      title: "Read-only result",
      goal: "Keep Root proof while recording specialist bookkeeping",
      acceptanceCriteria: ["preserve gates"],
    });
    intent = await store.transitionIntent(intent.id, "ready", intent.revision);
    intent = await store.transitionIntent(intent.id, "executing", intent.revision);
    intent = await store.transitionIntent(intent.id, "verifying", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      verification: "passed",
      evidence: [{ kind: "check", value: "read-only setup", result: "passed" }],
    });
    intent = await store.transitionIntent(intent.id, "reviewing", intent.revision);
    intent = await store.recordIntentEvidence(intent.id, intent.revision, {
      review: "accepted",
      acceptanceMet: true,
      rootReadiness: true,
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Record the already observed state",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["recorded"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    const result = await store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
      outcome: "completed",
      summary: "No repository evolution",
    });
    expect(result.assignment.revision).toBe(running.revision + 1);
    expect(result.intent.revision).toBe(intent.revision + 1);
    expect(result.intent.state).toBe("reviewing");
    expect(result.intent.verification.status).toBe("passed");
    expect(result.intent.review.status).toBe("accepted");
    expect(result.intent.acceptance_met).toBe(true);
    expect(result.intent.root_readiness).toBe(true);
    const directory = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    expect(await readdir(join(root, ".holycodex", directory))).not.toContain(
      ".holycodex-transaction.toon",
    );
  });

  test("recovers prepared and committed Assignment plus Intent transactions before reads", async () => {
    const { root, store } = await fixture();
    const intent = await store.createIntent({
      title: "Transaction recovery",
      goal: "Recover paired lifecycle records after interruption",
      acceptanceCriteria: ["recoverable"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Exercise durable recovery",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["recoverable"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    const directoryName = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    const directory = join(root, ".holycodex", directoryName);
    const assignmentPath = join(directory, "assignments", `${assignment.id}.toon`);
    const intentPath = join(directory, "intent.toon");
    const journalPath = join(directory, ".holycodex-transaction.toon");
    const nextAssignment = { ...running, revision: running.revision + 10 };
    const nextIntent = { ...intent, revision: intent.revision + 10 };
    const previousAssignmentText = `${encode(running)}\n`;
    const previousIntentText = `${encode(intent)}\n`;
    const nextAssignmentText = `${encode(nextAssignment)}\n`;
    const nextIntentText = `${encode(nextIntent)}\n`;
    const journal = (state: "prepared" | "committed") =>
      `${encode({
        schema_version: "holycodex-work-state-transaction-1",
        state,
        files: [
          {
            path: `assignments/${assignment.id}.toon`,
            previous: previousAssignmentText,
            next: nextAssignmentText,
          },
          { path: "intent.toon", previous: previousIntentText, next: nextIntentText },
        ],
      })}\n`;

    await writeFile(assignmentPath, nextAssignmentText, "utf8");
    await writeFile(journalPath, journal("prepared"), "utf8");
    await expect(store.readAssignment(intent.id, assignment.id)).resolves.toMatchObject({
      revision: running.revision,
    });
    await expect(readFile(journalPath, "utf8")).rejects.toThrow();
    await expect(readFile(assignmentPath, "utf8")).resolves.toBe(previousAssignmentText);
    await expect(readFile(intentPath, "utf8")).resolves.toBe(previousIntentText);

    await writeFile(assignmentPath, previousAssignmentText, "utf8");
    await writeFile(intentPath, previousIntentText, "utf8");
    await writeFile(journalPath, journal("committed"), "utf8");
    await expect(store.currentIntent()).resolves.toMatchObject({ revision: nextIntent.revision });
    await expect(store.readAssignment(intent.id, assignment.id)).resolves.toMatchObject({
      revision: nextAssignment.revision,
    });
    await expect(readFile(assignmentPath, "utf8")).resolves.toBe(nextAssignmentText);
    await expect(readFile(intentPath, "utf8")).resolves.toBe(nextIntentText);
  });

  test("replays a committed transaction before listing through a stale intent lock", async () => {
    const { root, store } = await fixture();
    const intent = await store.createIntent({
      title: "Stale journal listing",
      goal: "List only after committed lifecycle recovery",
      acceptanceCriteria: ["consistent"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Exercise stale lock replay",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["consistent"],
      },
      intent.revision,
    );
    const directoryName = (await readdir(join(root, ".holycodex"))).find(
      (entry) => entry !== "current",
    )!;
    const directory = join(root, ".holycodex", directoryName);
    const journalPath = join(directory, ".holycodex-transaction.toon");
    const startedAt = "2026-01-01T00:00:01.000Z";
    const nextAssignment = {
      ...assignment,
      status: "executing" as const,
      revision: assignment.revision + 1,
      active_invocation_id: "invocation-001",
      active_started_at: startedAt,
      updated_at: startedAt,
    };
    const nextIntent = {
      ...intent,
      state: "executing" as const,
      revision: intent.revision + 1,
      updated_at: startedAt,
    };
    await writeFile(
      journalPath,
      `${encode({
        schema_version: "holycodex-work-state-transaction-1",
        state: "committed",
        files: [
          {
            path: `assignments/${assignment.id}.toon`,
            previous: `${encode(assignment)}\n`,
            next: `${encode(nextAssignment)}\n`,
          },
          {
            path: "intent.toon",
            previous: `${encode(intent)}\n`,
            next: `${encode(nextIntent)}\n`,
          },
        ],
      })}\n`,
      "utf8",
    );
    const lockPath = join(directory, ".intent-store");
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 2 * 120_000);
    await utimes(lockPath, staleTime, staleTime);

    await expect(store.listIntents()).resolves.toEqual([expect.objectContaining(nextIntent)]);
    await expect(store.readAssignment(intent.id, assignment.id)).resolves.toMatchObject(
      nextAssignment,
    );
    await expect(readFile(journalPath, "utf8")).rejects.toThrow();
  });

  test("waits for an active writer before recovering or listing an Intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-work-state-race-"));
    let blockSnapshot = false;
    let snapshotStartedResolve!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      snapshotStartedResolve = resolve;
    });
    const snapshotRelease = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const store = new IntentStore(root, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      repositorySnapshot: async () => {
        if (blockSnapshot) {
          blockSnapshot = false;
          snapshotStartedResolve();
          await snapshotRelease;
        }
        return snapshot(root);
      },
    });
    const intent = await store.createIntent({
      title: "Writer lock race",
      goal: "Keep reads behind an active lifecycle writer",
      acceptanceCriteria: ["serialized"],
    });
    const assignment = await store.createAssignment(
      intent.id,
      {
        objective: "Hold the Intent writer lock",
        owner: { role: "Worker", task: "implementation" },
        scope: ["packages/core"],
        acceptanceCriteria: ["serialized"],
      },
      intent.revision,
    );
    const running = await store.startAssignment(intent.id, assignment.id, assignment.revision);
    blockSnapshot = true;
    const resultPromise = store.recordAssignmentResult(intent.id, assignment.id, running.revision, {
      outcome: "completed",
      summary: "Writer finished",
    });
    await snapshotStarted;

    const recoverPromise = store.recover();
    const listPromise = store.listIntents();
    const [recoverSettled, listSettled] = await Promise.all([
      Promise.race([
        recoverPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
      ]),
      Promise.race([
        listPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
      ]),
    ]);
    expect(recoverSettled).toBe(false);
    expect(listSettled).toBe(false);

    releaseSnapshot();
    const [result, , listed] = await Promise.all([resultPromise, recoverPromise, listPromise]);
    expect(listed).toEqual([expect.objectContaining(result.intent)]);
    expect(listed[0]?.revision).toBe(result.intent.revision);
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
