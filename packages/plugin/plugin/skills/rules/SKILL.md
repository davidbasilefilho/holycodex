---
name: rules
description: Use when asked how HolyCodex rules are discovered, matched, injected, deduped, limited, cached, or why loading fails; do not use merely because repo instructions exist or for skill routing. Produces an evidence-backed rule trace without unrelated content.
---

# Rules

Automatic when enabled: static rules on session start/user prompt, matching file rules after edit, cache clear after compact.

Sources: `CONTEXT.md`, `.holycodex/rules/**/*.md`, `.codex/rules/**/*.md`, `.github/instructions/**/*.md`, `.github/copilot-instructions.md`. Never load/reinject `AGENTS.md`.

Frontmatter: `alwaysApply: true` for static; `globs` accepts quoted/unquoted scalar, inline/multiline array. Inject body after frontmatter. Native/plugin rules dedupe by normalized-content hash. Caps: 8,000 chars/rule, 24,000/event.

Env: `HOLYCODEX_RULES_DISABLED=1`, `HOLYCODEX_RULES_MAX_RULE_CHARS`, `HOLYCODEX_RULES_MAX_RESULT_CHARS`.

Debug report: discovered files, metadata, target path, match, dedupe/cache; never expose unrelated rule content.
