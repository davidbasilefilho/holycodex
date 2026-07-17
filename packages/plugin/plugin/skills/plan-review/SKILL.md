---
name: plan-review
description: Use when a complete plan needs feasibility, scope, order, risk, or proof repair, including plan's review; do not use before initial drafting or repeatedly. Produces one executable plan; unlike plan it owns neither draft nor approval.
---

# Plan Review

On activation, first user-visible lines must be:

**PLAN REVIEW MODE ACTIVATED**
I detect plan-review intent — [reason]. [action].

Require request, initial plan, repo facts. If no initial plan exists, stop and return control to `plan`; never draft it.

One pass:

1. Compare plan with actual request, repo, constraints, evidence, and approved decisions. Map every material requirement to a step or explicit exclusion; expose contradictions, misunderstood intent, stale facts, unsupported assumptions, and unresolved product choices.
2. Trace entry points, state, API, data, generated files, docs, package, migration, cleanup, rollback. Find missing or needless surfaces, wrong scope/order, hidden or circular dependencies, overlapping writes, unsafe parallelism, wrong routing, pointless splitting, and tasks too large to verify.
3. Challenge feasibility, architecture fit, compatibility, data-loss/security/sandbox/permission risk, platform and mandatory Windows Git Bash behavior, hook/rule order, context recovery, attribution/license needs, frontend accessibility/motion, and preservation of user work.
4. Audit coordination cost: ownership, task/session reuse, dependency gates, reconciliation, token-heavy delegation, and root work better kept local. Block architecture or user decisions; label lesser repairs suggestions. Rank findings by impact before revising.
5. Audit proof: public behavior over implementation detail; focused regression, integration, migration, failure, static, build, generated/package, cleanup, and final diff/status checks. Reject vague criteria, unverifiable outcomes, duplicate checks, and plans continuing beyond real goal.
6. Remove speculation, premature abstraction, behavior-changing cleanup, unrelated work, ceremony, fake precision, and unsupported detail. Preserve approved choices.
7. Revise once into whole ordered executable plan. Each step names target, outcome, prerequisite/owner, proof, failure/rollback, decision gate, and stop. Ask user only when a material choice remains; otherwise return plan to `plan` for approval.

No reviewer agent, evidence folder, second review loop, or implementation. Stop after correction; `plan` owns approval.
