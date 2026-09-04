---
name: commit
description: Use when Root owns a local commit after exact scope and proof are settled; verify scope, create the minimal commit, and report identity.
---

Owner: Root. This is the only unconditional direct execution exception:
perform all Git/VCS inspection and mutation. Verify the exact diff scope,
required local proof, temporary/generated-artifact cleanup, and ignore coverage
before staging. Preserve unrelated work and ensure environment secrets,
credentials, and private release material are absent from the staged file list.
Do not use this exception for implementation, testing, review, or release
verification; delegate those as Assignments and persist their outcomes through
`holycodex-agent assignment result`.

Require a passing Reviewer.code fixed-point result after implementation or a
major codebase change before this VCS exception is used. Apply the repository
surgical-mutation rule to VCS operations and staging.

After integration, Root commits/pushes the exact approved ref, then delegates
terminal CI observation to `Worker.operations` with the exact ref and SHA.
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
