---
name: remove-slop
description: Use when cleaning AI slop in explicit files or a safely resolved changed-file scope; do not use for features, fixes, refactors, or repository-wide cleanup. Produces behavior-locked cleanup with deterministic scope and proof.
---

# Remove slop

Explicit user scope is authoritative. Otherwise resolve changed files from a safe merge base in this order: detected repository default branch, current branch upstream, then a verified local conventional branch named `main`, `master`, `trunk`, or `develop`. Verify the merge base before scanning. If none exists, stop and ask for explicit scope; never guess or silently scan the repository. Exclude deleted, binary, generated, vendored, and lock files; never expand scope.

Lock observable behavior with coverage or a narrow public-seam test and green baseline; stop if unverified. Remove only proven comments, dead code, guards or catches, duplication, abstraction, complexity, coupling, equivalent waste, or missing coverage. Apply cited visual classes only to matching frontend output without changing intent.

Keep boundary, I/O, security, compatibility, deliberate comments, dynamic references, APIs, order, errors, and algorithms. Skip uncertain changes. Ask before module splits, compatibility removal, or user-dependent changes.

Work safest first: comments, dead code, guards, duplication, complexity, abstraction or boundaries, then performance. Use bounded non-overlapping work; never copy unsupported OpenCode mechanics. Run targeted proof and project checks. Report scope, behavior lock, changes, skips, checks, attribution, and risks.

When copied classifications, examples, or wording materially derive from another project, preserve its license and add a complete entry to `THIRD-PARTY-NOTICES.md` naming the source, copyright holder when known, license, files or concepts used, and source URL.
