---
name: grill-me
description: Use when a material user decision blocks authorized work; ask Root's concise question through request_user_input.
---

# Grill me

Use this skill only when an unresolved material user decision blocks the next
step. It is not for routine omissions, safe implementation choices, or
planning.

Root only. For every clarification, call `request_user_input` with the smallest
set of questions needed to resolve the decision, in the user's language and
grounded in known evidence. Never ask what the session already establishes.
If no material question remains, continue without invoking this skill.

Continue independent authorized work while awaiting the answer. Do not ask
about hypothetical later phases. Specialists must not ask the user; they
return a `needs_root_input` outcome to Root with the specific decision and
why it blocks their Assignment. Root uses that outcome only when the answer
prevents further progress.
