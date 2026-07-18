---
name: plan-review
description: Use when a complete plan needs feasibility, scope, order, risk, or proof repair, including plan's review; do not use before initial drafting or repeatedly. Produces one executable plan; unlike plan it owns neither draft nor approval.
---

# Plan Review

On activation, first user-visible lines must be:

**PLAN REVIEW MODE ACTIVATED**
I detect plan-review intent — [reason]. [action].

Require request, initial plan, repo facts. If no initial plan exists, stop; return to `plan`.

One pass:

1. Compare plan against request, repo, constraints, evidence, decisions. Map every material requirement to a step or exclusion; expose contradictions, unsupported assumptions, unresolved product choices.
2. Trace entry points, API, data, generated files, docs, package, migration, cleanup, rollback; find wrong scope/order, circular dependencies, overlapping writes, unsafe parallelism, wrong routing, needless surfaces/splitting, unverifiable tasks.
3. Challenge compatibility, data-loss/security/sandbox/permission risk, mandatory Windows Git Bash behavior, context recovery, attribution/license needs, frontend accessibility/motion, user work.
4. Audit routing. Require Explorer before a second separable repository read/search or any multi-file or symbol fact pass; Librarian before a second external source or multi-source, version, or date research; Worker for fixed isolated implementation beyond one file, one substantive edit, or one proof cycle. Check ownership, reuse, gates, reconciliation, context-heavy delegation, `fork_turns="none"`, two lanes, local work. Never estimate exact monetary or token cost; specialists never delegate. Block architecture or user decisions; label lesser repairs suggestions. Rank findings by impact before revising.
5. Audit public-behavior proof: regression, integration, migration, failure, static, build, generated/package, cleanup, diff/status. Reject vague criteria, unverifiable outcomes, duplicates, plans continuing beyond real goal.
6. Remove speculation, premature abstraction, behavior-changing cleanup, unrelated work, ceremony, fake precision, unsupported detail. Preserve choices.
7. Revise once into executable plan: target, outcome, prerequisite/owner, proof, failure/rollback, decision gate, stop. Ask only for material choices; otherwise return plan to `plan` for approval.

No reviewer agent, evidence folder, second review loop, or implementation. Stop after correction; `plan` owns approval.
