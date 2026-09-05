---
name: writing-for-agents
description: Use when Root prepares or reviews a subagent delegation, handoff, profile, skill, prompt, or agent-facing instruction; write a low-context independent contract. Load it before the first dispatch, then reuse it while the current context contains a complete usable load.
---

# Writing for agents

Treat each instruction as an interface with one contract:

- **Owner:** the role permitted to act or decide.
- **Boundary:** the exact scope, authority, constraints, and escalation point.
- **Completion:** the observable outcome and proof that permit the agent to stop.
- **Return:** the result Root needs to integrate: outcome or findings, changed
  paths, verification, unresolved risk, and any requested decision.

Write an objective, scope, retained constraints, evidence, exclusions, and the
exact missing fact or material choice that returns to the owner. The receiver
must be able to act, prove, and stop without reconstructing intent.

Before any Root subagent dispatch, ensure this skill is fully loaded and applied
in the current context. Reuse the loaded instructions for later dispatches
while they remain complete and available; reload only when the current context
no longer contains a complete usable load.

## Dispatch contract

Root owns dispatch. Every specialist invocation is a bounded Assignment whose
objective, exact scope, exclusions, dependencies, acceptance criteria, proof
route, and return format are explicit. Independent, non-overlapping
Assignments may run concurrently; dependent work and writes to the same
mutable seam remain ordered. Leaves execute only their Assignment: they do not
delegate, message peers, mutate global Intent lifecycle, perform Git/VCS, or
make material product or architecture decisions.

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

Project the single repository surgical-mutation rule from `AGENTS.md` into
every write-capable Assignment: minimize the edit/write surface and operation
count while staying careful, complete, and evidence-driven. Do not create a
weaker or competing mutation variant in a profile, skill, or dispatch prompt.

When the document is a skill, read [SKILL-MECHANICS.md](SKILL-MECHANICS.md) for invocation and frontmatter mechanics.

Completion means the instruction routes at the right branch, names authority and exclusions, prevents premature completion, supplies checkable proof, and contains no duplicated or no-op policy.
