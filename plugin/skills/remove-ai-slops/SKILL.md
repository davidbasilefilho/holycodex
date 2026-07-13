---
name: remove-ai-slops
description: Use when a task asks to remove AI-generated code smells from an explicit diff or file scope without behavior changes; do not use for general refactors, features, bug fixes, or repository-wide cleanup. Produces behavior-locked removal of proven smell instances; unlike refactor it may cover several categories in fixed scope.
---

# Remove AI Slops

Lock behavior first. Work only branch changes or explicit files. No broad repo cleanup.

Categories: dead wrapper/helper; redundant guard or fallback; broad catch; vague narrative comment; duplicated path; needless object annotation; variant `if` chain; oversized mixed module; repeated post-action verification; inefficient equivalent work.

For each category:

1. Find exact instances.
2. Add regression test when behavior lacks coverage.
3. Confirm red where change fixes a bug; otherwise confirm behavior lock passes.
4. Remove smallest smell set.
5. Run targeted test and diagnostics.

Do not collapse distinct semantics, remove required compatibility, change error strings, reorder observable effects, or “simplify” security checks without proof. Finish with formatter, linter, strict types, targeted suite, and diff review.
