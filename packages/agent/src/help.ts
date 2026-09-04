// SPDX-License-Identifier: Apache-2.0

const ROOT = `Usage: holycodex-agent <intent|plan|assignment> <command> [options]

Deterministic model-facing work-state API. JSON responses use holycodex-agent-response-1.
All mutations require --revision and are atomic. No command prompts or emits ANSI.

Commands:
  intent      create, list, current, read, select, transition, evidence, complete, abandon
  plan        read, revise
  assignment  create, list, read, start, result

Use -h or --help at any command depth. Failures are classified and exit nonzero.
`;

const HELP: Readonly<Record<string, string>> = {
  intent: `Usage: holycodex-agent intent <command> [options]

Intent owns the durable global goal, lifecycle, baseline, blockers, gates, and readiness.
Commands: create, list, current, read, select, transition, evidence, complete, abandon.
Reads emit validated JSON. Mutations are atomic; stale revisions and invalid transitions fail.
`,
  "intent create": `Usage: holycodex-agent intent create --input <json> [--repo <path>]

Input: {"title":string,"goal":string,"acceptanceCriteria":string[],"planRequired"?:boolean,
"verificationRequired"?:boolean,"reviewRequired"?:boolean}. Output: created Intent.
Effect: creates .holycodex/{slug}-{short-id}/intent.toon and selects it as current.
Fails for invalid input, inaccessible Git repository, collision exhaustion, or I/O failure.
`,
  "intent list": `Usage: holycodex-agent intent list [--repo <path>]

Output: validated Intents sorted by id. Effect: interrupted temporary writes are removed.
Fails if persisted TOON is malformed or violates the current schema.
`,
  "intent current": `Usage: holycodex-agent intent current [--repo <path>]

Output: selected current Intent. No mutation. Fails when absent, ambiguous, or invalid.
`,
  "intent read": `Usage: holycodex-agent intent read --intent <id|slug|directory> [--repo <path>]

Output: one validated Intent. Effect: supported legacy schema is migrated atomically.
`,
  "intent select": `Usage: holycodex-agent intent select --intent <id|slug|directory> [--repo <path>]

Output: selected Intent. Effect: atomically changes the repository-local current pointer.
`,
  "intent transition": `Usage: holycodex-agent intent transition --intent <ref> --revision <n> --state <state> [--blocker <text>] [--repo <path>]

Output: revised Intent. Effect: applies one guarded lifecycle transition.
blocked/needs_root_input require --blocker. Use intent complete for completion.
`,
  "intent evidence": `Usage: holycodex-agent intent evidence --intent <ref> --revision <n> --input <json> [--repo <path>]

Input may record evidence, verification, review, acceptanceMet, rootReadiness, clearBlockers.
Effect: atomically updates Root-owned global proof. Review rejection returns to executing.
`,
  "intent complete": `Usage: holycodex-agent intent complete --intent <ref> --revision <n> [--repo <path>]

Output: completed Intent or completion_refused with machine-readable reasons.
Effect: completes only after assignments, blockers, verification, review, acceptance, and Root readiness pass.
`,
  "intent abandon": `Usage: holycodex-agent intent abandon --intent <ref> --revision <n> [--repo <path>]

Output: abandoned Intent. Effect: closes incomplete work without claiming completion.
`,
  plan: `Usage: holycodex-agent plan <read|revise> [options]

Plan is optional and describes execution. revise archives an existing canonical plan first.
`,
  "plan read": `Usage: holycodex-agent plan read --intent <ref> [--repo <path>]

Output: current validated Plan or null. No mutation.
`,
  "plan revise": `Usage: holycodex-agent plan revise --intent <ref> --revision <n> [--plan-revision <n>] --input <json> [--repo <path>]

Input requires approach and may include scope, assignments, dependencies, architecture, risks,
assumptions, openQuestions, verification, and recovery. Effect: archives plan.old-NNN.toon
immutably before atomic replacement. Fails on stale Intent or Plan revision.
`,
  assignment: `Usage: holycodex-agent assignment <create|list|read|start|result> [options]

Assignments are bounded specialist contracts. Their results never own global lifecycle state.
`,
  "assignment create": `Usage: holycodex-agent assignment create --intent <ref> --revision <n> --input <json> [--repo <path>]

Input requires objective, owner, scope, and acceptanceCriteria. Effect: creates one atomic
assignments/{id}.toon after repository drift validation.
`,
  "assignment list": `Usage: holycodex-agent assignment list --intent <ref> [--repo <path>]

Output: validated Assignments sorted by id. No mutation.
`,
  "assignment read": `Usage: holycodex-agent assignment read --intent <ref> --assignment <id> [--repo <path>]

Output: one validated Assignment. No mutation.
`,
  "assignment start": `Usage: holycodex-agent assignment start --intent <ref> --assignment <id> --revision <n> [--repo <path>]

Effect: marks a pending/blocked/failed Assignment executing. Completed work cannot restart.
`,
  "assignment result": `Usage: holycodex-agent assignment result --intent <ref> --assignment <id> --revision <n> --input <json> [--repo <path>]

Input requires outcome and summary; supports compact invocation metadata, evidence, blocker,
and remainingRisk. Effect: appends one invocation and accepts only declared repository evolution.
`,
};

/** Returns compact authoritative help for a command path. */
export function agentHelp(path: readonly string[]): string {
  return HELP[path.slice(0, 2).join(" ")] ?? HELP[path[0] ?? ""] ?? ROOT;
}

/** Detects either supported side-effect-free help spelling. */
export function agentHelpRequested(argv: readonly string[]): boolean {
  return argv.includes("-h") || argv.includes("--help") || argv.length === 0;
}
