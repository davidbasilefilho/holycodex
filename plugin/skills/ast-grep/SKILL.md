---
name: ast-grep
description: Search or rewrite code by syntax shape; use for safe repeatable codemods.
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
