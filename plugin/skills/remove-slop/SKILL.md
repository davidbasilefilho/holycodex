---
name: remove-slop
description: Use when cleaning AI slop in changed or explicit files; do not use for features, fixes, refactors, or repo-wide cleanup. Produces behavior-locked cleanup with proof.
---

# Remove slop

Explicit files win; otherwise use source since `git merge-base main HEAD`. Exclude deleted, binary, generated, vendored, lock files; never expand scope.

Lock observable behavior with coverage or a narrow public-seam test and green baseline; stop if unverified. Remove only proven comments, dead code, guards/catches, duplication, abstraction, complexity, coupling, equivalent waste, or missing coverage. Apply cited visual classes only to matching frontend output without changing intent.

Keep boundary/I-O/security handling, compatibility, deliberate comments, dynamic references, APIs, order, errors, algorithms. Skip uncertain changes. Ask before module splits, compatibility removal, user-dependent changes.

Work safest first: comments, dead code, guards, duplication, complexity, abstraction/boundaries, performance. Use bounded non-overlapping work; never copy unsupported OpenCode mechanics. Run targeted proof and project checks. Report scope, lock, changes/skips, checks, attribution, risks.

`THIRD-PARTY-NOTICES.md`.
