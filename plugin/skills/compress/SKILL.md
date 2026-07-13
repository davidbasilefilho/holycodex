---
name: compress
description: Rewrite any text, skill, prompt, documentation, instructions, prose, notes, or structured content to use fewer words and tokens while preserving meaning, facts, constraints, safety, tone, and required structure. Use when asked to compress, condense, tighten, shorten, de-duplicate, optimize token usage, or rewrite using caveman principles.
---

# Compress

Rewrite with caveman principles: all substance stays; filler dies. Do not automatically adopt caveman voice unless user requests it. Default output remains clear, grammatical, and natural.

## Workflow

1. Identify purpose, audience, format, required facts, exact strings, constraints, decision gates, safety warnings, examples, links, and tone.
2. Remove repetition, throat-clearing, filler, redundant headings, obvious explanation, decorative adjectives, and verbose transitions.
3. Merge related rules. Prefer direct verbs, short familiar words, compact lists, and one statement per fact.
4. Preserve technical names, code, commands, paths, APIs, error strings, numbers, citations, legal terms, and user-defined terminology exactly unless correction is requested.
5. Preserve ordering when sequence matters. Keep full grammar where compression could create ambiguity, especially safety, irreversible actions, legal/medical guidance, or multi-step operations.
6. Check compressed output against source: no lost requirement, changed meaning, weakened prohibition, invented claim, broken reference, or altered scope.

## Content Rules

- **Skills/prompts:** preserve YAML frontmatter, trigger coverage, imperative instructions, tool/resource references, permissions, stop conditions, and validation. Remove duplicated “when to use” prose from body when frontmatter already carries it.
- **Code/config:** never compress syntax or identifiers unless explicitly asked to refactor. Compress surrounding explanation only.
- **Prose/docs:** preserve thesis, evidence, nuance, attribution, and intended tone. Remove repeated framing and examples that add no distinct value.
- **Lists/tables:** merge duplicates; keep mappings and comparisons when format improves scan speed.

If user sets length/ratio/style, follow it. Otherwise aim for largest safe reduction, not shortest possible output. Report before/after size only when useful or requested.
