---
name: ast-grep
description: Use only for syntax-aware search or repeatable AST-shaped codemods; do not use for text search, one local edit, or symbol navigation. Produces deterministic syntax matches or rewrites, not identity-aware LSP results.
---

# ast-grep

Use `sg` for syntax, `rg` for text.

1. Name language/exact shape.
2. Search first with smallest metavariable pattern.
3. Inspect match classes; constrain only as needed.
4. Test rewrite narrowly; review diff.
5. Apply deterministically; format, diagnose, test.

Search: `sg run -p '<pattern>' -l <language> <path>`. Use YAML for constraints, relations, reusable codemods. Review matches before writes; never regex-replace syntax code.

Load only needed reference: `patterns.md`, `yaml-rules.md`, `recipes.md`, `pitfalls.md`, `sgconfig.md`, `cli.md`, or `install.md`.
