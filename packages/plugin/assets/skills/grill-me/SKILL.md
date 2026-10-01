---
name: grill-me
description: Use when intent, implementation, or findings are materially unclear and need the user's project decision; ask Root's smallest unresolved question through the supported input tool.
---

# Grill me

Use this skill only when uncertainty about intent, implementation, or findings
requires the user's project decision. Do not invoke it when the request is
clear enough to proceed with a safe in-scope choice; it is not for routine
omissions or planning.

Root only. Route every permitted question through the input-tool priority and
pending-answer rules in Root's canonical developer instructions; never ask
through prose. Follow each tool's contract, including restrictions on
permission requests. Ask only what remains unresolved, in the user's language
and grounded in known evidence. If no material decision remains, continue
without invoking this skill.

Continue independent authorized work while awaiting the answer. Do not ask
about hypothetical later phases. Specialists must not ask the user; they
return a `needs_root_input` outcome to Root with the specific decision and
why it blocks their Assignment. Root uses that outcome only when the answer
prevents further progress.
