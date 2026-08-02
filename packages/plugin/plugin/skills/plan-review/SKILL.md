---
name: plan-review
description: Use when a complete plan needs feasibility, scope, order, risk, or proof repair; do not use before drafting, for approval/implementation, or twice. Produces one corrected plan; unlike plan, it owns neither draft nor approval.
---

# Plan Review

After full load, first visible lines:

**PLAN REVIEW MODE ACTIVATED**
I detect plan-review intent: [reason]. [action].

Require request, complete plan, decisions, criteria, repo facts. If incomplete, return to `plan`. Review once after drafting: no preload, parallel review, reviewer, evidence folder, approval, implementation, or loop. `plan` owns draft/approval.

1. **Requirement ledger.** Map each material requirement, constraint, criterion, decision, exclusion, proof to a step, exclusion, or blocker. Reject gaps/conflicts; preserve architecture, scope, user choices.
2. **Fact audit.** Verify files/symbols/entry points, APIs, commands/scripts, dependencies, generated/package behavior, conventions, external facts; invent nothing. Explorer is mandatory before a second separable repo search or multi-file/symbol pass; Librarian before a second external source or multi-source/version/date pass. At most two `fork_turns="none"` lanes; no specialist delegation.
3. **Execution graph.** Trace prerequisites, order/owner/state, migrations, generated/docs/package/publication work, cleanup/rollback/stops. Find cycles, gaps, write overlap, unsafe parallelism, stale output, wrong routing/timing. Worker is mandatory for fixed isolated work beyond one file, substantive edit, or proof cycle; review never implements.
4. **Adversarial audit.** Challenge assumptions, regressions, missing edges/failures, evidence. Cover compatibility/data loss, security/permissions/sandbox, concurrency/state/performance, migrations/user work, platforms/Windows Git Bash, context recovery, licensing/attribution, frontend accessibility/motion. Block material architecture/product choices. Qualifying UI/frontend work requires Build Web Apps `frontend-app-builder` concept/design approval; if absent require enabling it. Read-only UI audit is exempt.
5. **Proof matrix.** Map behavior/regression/migration/failure, generated/package/publication results, cleanup to exact checks/results. Require targeted then proportional static/integration/build/package/generation, Git diff/status, relevant rollback proof. Reject vague, duplicate, unverifiable, post-goal checks.
6. **Scope audit.** State changed/untouched surfaces; remove unrelated cleanup, speculation, premature abstraction, duplicate/unneeded work, behavior-changing refactors, unsupported detail, ceremony, fake precision, post-goal work. Never estimate exact monetary/token cost.
7. **Result.** Return ranked findings, corrected plan, unresolved material decisions, residual risks, approval readiness. Each step names surface/outcome, prerequisites/owner, exact proof/result, failure/rollback, decision gate, stop. Ask only material choices; return to `plan`.

No reviewer, evidence folder, second review, or implementation. Stop after correction.
