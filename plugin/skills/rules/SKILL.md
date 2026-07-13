---
name: rules
description: Use when a task asks how HolyCodex rules are discovered, matched, injected, deduplicated, limited, cached, or why rule loading is wrong; do not use merely because repository instructions exist or for skill routing. Produces an evidence-backed rule trace without exposing unrelated content; unlike general debugging it owns this pipeline.
---

# Rules

Automatic when plugin enabled. Static rules load on session start and user prompt. File rules load after matching edit. Post-compact clears session cache.

Sources: `CONTEXT.md`, `.holycodex/rules/**/*.md`, `.codex/rules/**/*.md`, `.github/instructions/**/*.md`, `.github/copilot-instructions.md`. Never load or reinject `AGENTS.md`.

Frontmatter: `alwaysApply: true` for static rule; `globs` string or list for path match. Body after frontmatter is injected. Native and plugin rules dedupe by normalized content hash. Per-rule cap 8,000 chars; event cap 24,000 chars.

Environment: `HOLYCODEX_RULES_DISABLED=1`, `HOLYCODEX_RULES_MAX_RULE_CHARS`, `HOLYCODEX_RULES_MAX_RESULT_CHARS`.

When debugging rules, report discovered files, parsed metadata, target path, match result, dedupe/cache result. Do not expose unrelated rule content.
