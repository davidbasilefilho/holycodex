---
name: code-review
description: Use exactly once after every code or manifest implementation, and for a user-requested snippet, file, directory, diff, patch, or PR review. Runs the final Root-owned audit, repairs weak work, proves it proportionally, and decides readiness; do not use for implementation, plan review, or non-code review.
---

# Code Review

Only after full load, first user-visible line:

**CODE REVIEW MODE ACTIVATED**

Root owns scope, integration, commands, final judgment/verification/result and is not another implementation branch. Evaluate all specialist output against scope, fixed architecture, user decisions, repository conventions, and proof. Reject or repair weak output and integrate only accepted work. Never delegate review. Explorer may find facts; Worker may fix isolated code but never integrates/verifies finally. Invoke this skill exactly once after implementation or an explicit review request, then converge within that invocation: repair, proportionally rerun affected proof, and reinspect until clean or materially blocked.

1. Load request, approved plan, criteria, decisions, exclusions, results, repo rules/state.
2. Capture Git status, working/staged diffs, untracked files; preserve user work. Unchanged/supplied code review includes affected callers, consumers, contracts.
3. Map requirements/plan to implementation/proof; find omissions, contradictions, drift.
4. Inspect changes/consumers across APIs, types, state/data, config, manifests, migrations, generated files, docs, tests/fixtures, packaging/publication.
5. Check correctness/completeness, edges/failures/errors, security/permissions, compatibility/migrations, concurrency/state, performance, types/exhaustiveness, reuse/duplication, abstraction/dead code, logging, user work, test quality.
6. Fix all in-scope issues. Outside behavior changes need user decision unless required for requested correctness/safety.
7. Discover native commands from manifests, workspace config, docs, CI; invent none. In order run applicable format, lint, strict types, targeted/proportional tests, build, package/publication, generated consistency. Use `request_user_input` immediately before any build, compile, package, publish, deploy, commit, push, or tag action. Obey safety, sandbox, permission, platform, generation, licensing, package, cleanup, verification rules; never substitute forbidden commands.
8. For every repair or implementation failure, rerun the affected checks at proportional scope, then separate new failures from preexisting or external failures with evidence.
9. Reinspect repaired paths, callers, consumers, contracts, and final diff/status for formatter, generated/staged drift, scope, and introduced accidents. Remove debug artifacts, stale/unrelated output, or incomplete cleanup; never discard user work.
10. Repeat mapping, inspection, repair, proportional reruns, and reinspection within this one invocation while material progress remains. Stop when clean/green, materially blocked, or repeated external/preexisting failure is proven unrelated.
11. Root reconciles delegated facts/fixes, integrates, verifies, decides readiness. Worker proof is never final.
12. Report scope, repairs, exact checks/results, skips/reasons, external/preexisting blockers, residual risk, status.

`plan-review` repairs plans before approval; this audits code. Prose/docs-only work, status/explanation, implementation, and planning skip it without explicit code review.
