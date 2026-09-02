---
name: commit
description: Use when Root assigns a local commit after the exact scope is settled; verify scope, commit it, and report identity.
---

Owner: Worker. Boundary: verify status and commit only the assigned local
scope. Preserve unrelated work; remote version-control mutation remains
approval-gated.

Completion: the commit identity and post-commit status are reported, or an
exact reproducible blocker is returned.
