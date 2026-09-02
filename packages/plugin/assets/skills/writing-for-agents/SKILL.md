---
name: writing-for-agents
description: Use when authoring or reviewing prompts, skills, profiles, delegations, handoffs, or agent-facing repository instructions; make them independently actionable with low context load.
---

# Writing for agents

Treat each instruction as an interface with one contract:

- **Owner:** the role permitted to act or decide.
- **Boundary:** the exact scope, authority, constraints, and escalation point.
- **Completion:** the observable outcome and proof that permit the agent to stop.

Write an objective, scope, retained constraints, evidence, exclusions, and the exact missing fact or material choice that returns to the owner. The receiver must be able to act, prove, and stop without reconstructing intent.

## Information design

A **context pointer** names out-of-context material and front-loads the branches that load it. Keep one trigger per genuine branch; synonyms spend permanent context without improving routing.

Budget two loads:

- **Context load:** always-loaded descriptions and repository rules.
- **Cognitive load:** material a person must remember and select.

Place information by immediacy: in-file steps, in-file reference, then disclosed reference. Inline what every invocation needs. Put branch-specific mechanics behind a clear pointer. Co-locate each concept with its rules and caveats; split real invocation or sequence branches when one file sprawls or later steps cause premature completion.

Each step needs a clear, demanding completion criterion. Sharpen a vague bound before splitting the sequence. Use leading words with useful pretrained meaning to compress repeated concepts. Prefer positive steering; keep prohibitions for hard guardrails and pair them with the target behavior.

## Pruning

Keep each meaning in one source of truth. Treat code, configuration, directory layout, and `--help` as authoritative environment lookups; document only reasons, gotchas, or contracts the environment cannot reveal. Delete stale caches, irrelevant branches, sediment, and instructions that do not change model behavior.

Use architectural role names: Root owns material decisions, Workers implement bounded seams, Reviewers repair their assigned findings to fixed point, and other specialists follow their literal authority. Continuations carry changed constraints, evidence, decisions, and semantic delta instead of replaying accepted context.

When the document is a skill, read [SKILL-MECHANICS.md](SKILL-MECHANICS.md) for invocation and frontmatter mechanics.

Completion means the instruction routes at the right branch, names authority and exclusions, prevents premature completion, supplies checkable proof, and contains no duplicated or no-op policy.
