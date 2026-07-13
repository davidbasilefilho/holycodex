---
name: refactor
description: Behavior-preserving structural change with tests and semantic navigation. Use when asked to refactor, restructure, extract, simplify, or modernize code.
---

# Refactor

Scope one smell or seam. No feature, formatting sweep, rename drift, or cleanup bundle.

1. Map target responsibility, callers, references, tests, public contract.
2. State invariant that must remain true.
3. Add or run behavior-locking test before move.
4. Use LSP references/rename for symbols. Use AST rewrite for repeated syntax shape.
5. Move one responsibility at time. Keep compatibility only when contract requires it.
6. Run smallest test after each semantic move.
7. Delete obsolete path only after all callers move.
8. Run strict diagnostics and proportional suite.

Good split follows ownership, lifecycle, policy, or dependency boundary. Bad split creates pass-through files, one-call helpers, generic `utils`, or cycles.

Stop and reassess if public API changes, tests cannot distinguish behavior, concurrent user edits overlap, or required migration exceeds request.
