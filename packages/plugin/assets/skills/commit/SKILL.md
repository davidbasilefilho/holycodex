---
name: commit
description: Use when Root owns a local commit after exact scope and proof are settled; verify scope, create the minimal commit, and report identity.
---

Owner: Root. Boundary: perform all Git/VCS inspection and mutation. Verify the
exact diff scope, required local proof, temporary/generated-artifact cleanup,
and ignore coverage before staging. Preserve unrelated work and ensure
environment secrets, credentials, and private release material are absent from
the staged file list. Local commits need no user approval; every exact push,
tag, merge, CI trigger, publication, or other remote mutation requires fresh
user approval through native `request_user_input` immediately beforehand.

Completion: Root reports the commit identity and post-commit status with
redacted evidence, or returns an exact reproducible blocker. Never print secret
values.
