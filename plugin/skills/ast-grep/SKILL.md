---
name: ast-grep
description: AST-aware search and deterministic rewrite. Use when a code pattern depends on syntax shape or needs a safe repeatable codemod.
---

# ast-grep

Use `sg` when target is syntax shape: function, call, class, import, missing `await`, empty catch, unsafe assertion, or codemod. Use `rg` for plain text.

## Flow

1. Name language and exact syntax shape.
2. Start search-only. Use smallest pattern with metavariables.
3. Inspect every match class. Add `inside`, `has`, `not`, or relational rule only when needed.
4. Test rewrite on narrow path. Review diff.
5. Apply deterministic rewrite. Run formatter, diagnostics, targeted tests.

Use `sg run -p '<pattern>' -l <language> <path>` for simple search. Use YAML rule for constraints, relational matching, or reusable codemod. Never run write mode before match review. Never use regex replacement for syntax-bearing code.

Load only needed reference: `patterns.md`, `yaml-rules.md`, `recipes.md`, `pitfalls.md`, `sgconfig.md`, `cli.md`, or `install.md`.
