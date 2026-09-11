---
name: commit
description: Use when Root creates a local commit after scope and proof are settled.
---

Root uses this workflow after exact scope and local proof are settled. Verify
the diff, generated-artifact cleanup, ignore coverage, and staged secret
exclusions before creating the local commit.

Require a passing Reviewer.code fixed-point result after implementation or a
major codebase change before this VCS exception is used.

After integration, Root commits the exact authorized scope. For subsequent CI
or release work, load [babysit-ci](../babysit-ci/SKILL.md), which owns that
lifecycle. Root's authority policy owns approval requirements and existing
user authorization.

Completion: Root reports the commit identity and post-commit status with
redacted evidence, or returns an exact reproducible blocker. Never print secret
values.
