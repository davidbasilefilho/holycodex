---
name: refactor
description: Use for behavior-preserving restructuring, extraction, simplification, modernization, or cleanup of one seam; do not use for features, fixes, formatting sweeps, or broad slop cleanup. Produces one behavior-locked structural change.
---

# Refactor

Scope one smell/seam; no feature, formatting sweep, rename drift, cleanup bundle.

1. Map responsibility, callers/references, tests, public contract; state invariant.
2. Add/run behavior-lock test before moving.
3. Use LSP references/rename for symbols; AST rewrite for repeated syntax.
4. Move one responsibility at a time; keep compatibility only when contracted.
5. Run smallest test after each semantic move.
6. Delete obsolete path only after callers move; run strict diagnostics/proportional tests.

Good splits follow ownership, lifecycle, policy, dependency. Bad splits create pass-through files, one-call helpers, generic `utils`, cycles. Stop if API changes, tests cannot distinguish behavior, user edits overlap, or migration exceeds scope.
