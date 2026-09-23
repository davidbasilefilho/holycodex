---
name: commit
description: Use when Root creates a local commit after scope and proof are settled.
---

Root uses this workflow after exact scope and local proof are settled. Discover
the repository's commit naming convention from its guidance or recent history
when needed. Split the change into clean, coherent commits that each have a
separately meaningful purpose; a single user request is not a reason to group
unrelated changes. Verify each staged diff, generated-artifact cleanup, ignore
coverage, and secret exclusions before creating its local commit.

Require a passing Reviewer.code fixed-point result after implementation or a
major codebase change before this VCS exception is used.

After integration, Root commits the exact authorized scope. For subsequent CI
or release work, load [babysit-ci](../babysit-ci/SKILL.md), which owns that
lifecycle. Root's authority policy owns approval requirements and existing
user authorization.

Completion: Root reports each commit identity and post-commit status with
redacted evidence, or returns an exact reproducible blocker. Never print secret
values.
