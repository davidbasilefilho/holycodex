---
name: commit
description: Use when Root owns a local commit after exact scope and proof are settled; verify scope, create the minimal commit, and report identity.
---

Root uses this workflow after exact scope and local proof are settled. Verify
the diff, generated-artifact cleanup, ignore coverage, and staged secret
exclusions before creating the local commit.

Require a passing Reviewer.code fixed-point result after implementation or a
major codebase change before this VCS exception is used.

After integration, Root commits the exact approved ref and gives its exact ref
and SHA to `Worker.operations` for terminal CI observation.
Discover the repository's actual development/release topology first; never
assume GitHub, branch names, or that pending is success. Delegate fixes for
failures, then repeat integration, commit, push, and observation until the
repository gate is terminal green. If release is authorized, Root performs the
repository's own release mechanism only after the development gate is terminal
green, then delegates terminal release verification. If development and release
share one pipeline, or the repository has no distinct release gate, record that
topology and apply the repository's one available terminal gate. Fix failures
through a new bounded Assignment and repeat the same review/VCS/observation
cycle.

Local commits need no user approval; every exact push, tag, merge, CI trigger,
publication, or other remote mutation requires fresh user approval through
native `request_user_input` immediately beforehand.

Completion: Root reports the commit identity and post-commit status with
redacted evidence, or returns an exact reproducible blocker. Never print secret
values.
