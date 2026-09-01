# Skill mechanics

This is the skill-specific branch of [writing-for-agents](SKILL.md): frontmatter, invocation choice, and router skills.

## Invocation

A **model-invoked** skill keeps a trigger-first `description` so an agent can select it and another skill can reach its shared reference. The always-loaded pointer spends context on every turn, so use one compact trigger per real branch and remove routing prose from the body.

A **user-invoked** skill sets `disable-model-invocation: true`. Its description becomes a human-facing one-line summary with trigger lists removed. Use this when only a person should select the skill.

Shared reference required by user-invoked skills belongs in a plain disclosed file that each can point to.

## Splitting by invocation

Split a model-invoked skill only when a distinct leading word should trigger it independently or another skill must reach it. The independent route must justify its permanent context pointer.

## Router skills

When many user-invoked skills exceed human cognitive load, add one user-invoked router that names them and their branches. A router can guide the person; it cannot autonomously invoke skills whose model invocation is disabled.
