---
name: code-review
description: Use when Root must run the mandatory final audit after code or manifest implementation, or explicitly review existing or supplied code; do not use for initial implementation, plan review, or prose-only, docs-only, status, or explanation work absent explicit review. Produces repaired, verified code and a final Root judgment.
---

# Code Review

Root owns scope comparison, integration, final judgment, command choice, final verification, and the user result. Never create or delegate a reviewer. Explorer may supply bounded facts; Worker may implement isolated fixes, but never owns integration or final verification. Audit once after implementation; repairs do not start another audit.

## Workflow

1. Load the full task request, any approved plan, acceptance criteria, fixed decisions, exclusions, implementation results, and repository instructions and state.
2. Capture the complete changed scope with Git status, working-tree diff, staged diff, and untracked files. Preserve unrelated user work.
3. For explicit review of unchanged or supplied code, resolve the exact surface plus affected callers, consumers, and contracts.
4. Compare every requirement and approved plan item with implementation and proof; identify omissions, contradictions, and scope drift.
5. Inspect changed code and affected callers, consumers, public APIs, types, data and state flows, configuration, manifests, migrations, generated files, docs, tests, fixtures, packaging, and publication surfaces.
6. Review correctness, completeness, edge and failure behavior, errors, security, permissions, compatibility and migrations, concurrency and state, performance, typing and exhaustive variants, reuse and duplicate policy, needless abstraction, cleanup and dead code, logging, user-work preservation, and test quality.
7. Fix every in-scope issue instead of merely reporting it. Do not broaden scope; behavior changes outside the request require a user decision unless necessary for requested correctness or safety.
8. Discover native commands from manifests, workspace configuration, repository docs, and CI. Root chooses commands; invent none.
9. Run relevant checks in order: formatter, linter, strict type checker, targeted tests, proportional broader tests, build, package or publication checks, and generated consistency.
10. Respect repository safety, sandbox, permission, platform, generated-file, licensing, package, cleanup, and verification constraints; do not substitute forbidden commands.
11. Fix failures caused by the implementation, then rerun every affected check. Distinguish new failures from preexisting or external failures with evidence.
12. After automation, inspect final Git diff and status to catch formatter effects, generated changes, staging differences, and scope drift.
13. Remove accidents, debug artifacts, stale outputs, unrelated edits, and incomplete cleanup introduced by the work; never discard user-owned changes.
14. Continue only while making material progress. There is no arbitrary loop count. Stop when the owned scope is clean and relevant checks pass, a material user decision blocks correctness, or the same external or preexisting failure repeats after evidence rules out the implementation.
15. Final judgment remains Root's: reconcile delegated facts and fixes, confirm integration, perform final verification, and decide readiness. Worker verification is never final.
16. Report reviewed scope, fixes made, exact commands and checks with results, skipped checks with reasons, preexisting or external blockers, residual risks, and final status.

`plan-review` repairs a complete plan before approval; this skill audits code. Prose-only or docs-only changes, ordinary status or explanation, initial implementation, and plan review do not route here unless the user explicitly requests code review.
