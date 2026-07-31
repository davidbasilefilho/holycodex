---
name: plan-review
description: Use when a complete initial plan needs feasibility, scope, order, risk, or proof repair; do not use before initial drafting, for approval or implementation, or repeatedly. Produces one corrected executable plan; unlike plan, it owns neither draft nor approval.
---

# Plan Review

Only after this skill is fully loaded, its first user-visible lines must be:

**PLAN REVIEW MODE ACTIVATED**
I detect plan-review intent: [reason]. [action].

Require the request, complete initial plan, decisions, criteria, and repository facts. If no complete plan exists, stop and return to `plan`. Review once, after completion: no preload, parallel review, reviewer agent, evidence folder, approval, implementation, or loop. `plan` owns drafting and approval.

## Procedure and artifacts

1. **Requirement ledger.** Enumerate every material requirement, constraint, acceptance criterion, fixed decision, exclusion, and requested proof. Map each to an exact plan step, explicit exclusion, or blocker; reject anything unmapped or contradicted. Preserve architecture, scope, and user choices.
2. **Fact audit.** Verify every material repository claim, including files, symbols, entry points, APIs, commands, scripts, dependencies, generated outputs, package behavior, conventions, and external facts. Invent no path, symbol, command, capability, or assumption. Explorer is mandatory before a second separable repository read/search or any multi-file or symbol fact pass; Librarian before a second external source or multi-source, version, or date research. Use at most two lanes with `fork_turns="none"`; delegate separable context-heavy work, and specialists never delegate.
3. **Execution graph.** Trace prerequisites, order, ownership, state transitions, migrations, generated files, docs, package and publication work, cleanup, rollback, and stops. Detect cycles, missing prerequisites, overlapping writes, unsafe parallelism, stale outputs, wrong routing, and early or late steps. Worker is mandatory for fixed isolated implementation beyond one file, one substantive edit, or one proof cycle, but plan review never implements.
4. **Adversarial audit.** For each material step ask what assumption may be false, what can regress, which edge or failure is missing, and what evidence would expose error. Cover compatibility, data loss, security, permissions, sandboxing, concurrency, state, performance, migrations, user work, platform behavior, mandatory Windows Git Bash use, context recovery, attribution and licensing, and frontend accessibility and motion. Block material architecture or product decisions; label lesser repairs as suggestions. For qualifying UI or frontend implementation, require routing to Build Web Apps `frontend-app-builder` and its concept and design-approval workflow before implementation details. If unavailable, tell the user to enable Build Web Apps through Codex; do not block review solely on absence. Read-only UI audits are exempt.
5. **Proof matrix.** Map every visible behavior, regression, migration, failure, generated or package result, publication result, and cleanup outcome to an exact check and expected result. Require targeted then proportional broader proof, including static, integration, build, package, generated consistency, Git diff/status, and rollback checks when relevant. Reject vague criteria, duplicate proof, unverifiable outcomes, and checks that continue after the goal.
6. **Scope audit.** State what changes and remains untouched. Remove unrelated cleanup, speculation, premature abstraction, unneeded files or surfaces, duplicate work, behavior-changing refactors, unsupported detail, ceremony, fake precision, and post-goal tasks. Never estimate exact monetary or token cost.
7. **Result.** Return, in order: ranked findings, the corrected executable plan, unresolved material decisions, residual risks, and ready-for-approval status. Every corrected step names target surface, intended outcome, prerequisites and owner, exact proof and expected result, failure or rollback behavior, decision gate when applicable, and stop condition. Ask only material choices, then return the result to `plan` for approval.

No reviewer agent, evidence folder, second review loop, or implementation. Stop after this single correction; return the corrected plan to `plan` for approval.
