---
name: code-review
description: Use when Root must audit implemented code/manifests or explicitly review code; do not use for implementation, plan review, or prose/docs/status/explanation without explicit review. Produces repaired, verified code and Root judgment.
---

# Code Review

Root owns scope, integration, commands, final judgment/verification/result. Never delegate review. Explorer may find facts; Worker may fix isolated code but never integrates/verifies finally. Audit once; repairs do not restart it.

1. Load request, approved plan, criteria, decisions, exclusions, results, repo rules/state.
2. Capture Git status, working/staged diffs, untracked files; preserve user work. Unchanged/supplied code review includes affected callers, consumers, contracts.
3. Map requirements/plan to implementation/proof; find omissions, contradictions, drift.
4. Inspect changes/consumers across APIs, types, state/data, config, manifests, migrations, generated files, docs, tests/fixtures, packaging/publication.
5. Check correctness/completeness, edges/failures/errors, security/permissions, compatibility/migrations, concurrency/state, performance, types/exhaustiveness, reuse/duplication, abstraction/dead code, logging, user work, test quality.
6. Fix all in-scope issues. Outside behavior changes need user decision unless required for requested correctness/safety.
7. Discover native commands from manifests, workspace config, docs, CI; invent none. In order run applicable format, lint, strict types, targeted/proportional tests, build, package/publication, generated consistency. Obey safety, sandbox, permission, platform, generation, licensing, package, cleanup, verification rules; never substitute forbidden commands.
8. Fix implementation failures; rerun affected checks. Separate new from preexisting/external failures with evidence.
9. Inspect final diff/status for formatter, generated/staged drift, scope. Remove introduced accidents, debug artifacts, stale/unrelated output, incomplete cleanup; never discard user work.
10. Continue only with material progress; no arbitrary loop count. Stop when clean/green, materially blocked, or repeated external/preexisting failure is proven unrelated.
11. Root reconciles delegated facts/fixes, integrates, verifies, decides readiness. Worker proof is never final.
12. Report scope, repairs, exact checks/results, skips/reasons, external/preexisting blockers, residual risk, status.

`plan-review` repairs plans before approval; this audits code. Prose/docs-only work, status/explanation, implementation, and planning skip it without explicit code review.
