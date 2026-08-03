---
name: remove-slop
description: Use only when cleaning AI slop, boilerplate, cruft, or bloat in explicit files or resolved changed files; do not use for features, fixes, refactors, or repository-wide cleanup. Produces behavior-locked cleanup with deterministic proof.
---

# Remove slop

Explicit user scope wins. Otherwise resolve changed files from a verified merge base in order: repo default branch, current upstream, then verified local `main`, `master`, `trunk`, or `develop`. Without one, stop and ask scope; never guess or scan repo. Exclude deleted, binary, generated, vendored, lock files; never expand.

Lock behavior with coverage or narrow public-seam test and green baseline; stop if unverified. Remove only proven comments, dead code, guards/catches, duplication, abstraction, complexity, coupling, equivalent waste, or missing coverage. Apply cited visual classes only to matching frontend output without changing intent.

Keep boundaries, I/O, security, compatibility, deliberate comments, dynamic references, APIs, order, errors, algorithms. Skip uncertainty. Ask before module splits, compatibility removal, user-dependent changes.

Work safest first: comments, dead code, guards, duplication, complexity, abstraction/boundaries, performance. Keep work bounded/non-overlapping; never copy unsupported OpenCode mechanics. Run targeted proof/project checks; report scope, behavior lock, changes, skips, checks, attribution, risks.

Materially copied classifications, examples, or wording retain their license and add complete `THIRD-PARTY-NOTICES.md` entry: source, known copyright holder, license, used files/concepts, URL.
