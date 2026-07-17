---
name: ast-grep
description: Use when a task needs syntax-aware code search or a repeatable structural rewrite across AST-shaped matches; do not use for plain text search, one local edit, or symbol navigation. Produces reviewed deterministic matches or a codemod; unlike LSP it matches syntax, not symbol identity.
---

# ast-grep

Use `sg` for syntax shapes; use `rg` for text.

## Flow

1. Name language and exact syntax shape.
2. Start search-only. Use smallest pattern with metavariables.
3. Inspect match classes; constrain only as needed.
4. Test rewrite on narrow path. Review diff.
5. Apply deterministic rewrite. Run formatter, diagnostics, targeted tests.

Simple search: `sg run -p '<pattern>' -l <language> <path>`. Use YAML for constraints, relations, or reusable codemods. Review matches before writes. Never regex-replace syntax-bearing code.

Load only needed reference: `patterns.md`, `yaml-rules.md`, `recipes.md`, `pitfalls.md`, `sgconfig.md`, `cli.md`, or `install.md`.
