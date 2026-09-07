---
name: writing-for-agents
description: Use when GPT-6 Astra Root writes or reviews a GPT-5.6 Luna specialist contract.
---

# Writing for agents

This skill helps GPT-6 Astra Root author instructions for GPT-5.6 Luna. First
identify Luna's effective context: the generated Luna baseline, repository
`AGENTS.md`, the selected native Role.task, loaded skills, and relevant config
or metadata. Do not restate a directive already visible to that receiver.

Give each Assignment only the delta Luna needs:

- objective and exact scope;
- relevant context and authority;
- unique hard constraints and exclusions;
- acceptance criteria and required evidence;
- the material choice or blocker that must escalate;
- the return payload and stopping condition.

Place new policy at the narrowest owner: Root/session behavior in Root
instructions, repository conventions in `AGENTS.md`, Luna-global constraints in
the generated baseline, task-specific behavior in Role.task, and conditional
workflow in a skill or a disclosed reference. Keep invocation metadata as
routing metadata.

State completion before optional procedure. Use positive, literal boundaries,
and disclose uncommon branches progressively. Let Astra infer routine safe
defaults and use its judgment to decide what Luna actually needs; do not add
competence scaffolding, generic recipes, or a broad questionnaire.

When a contract is complete, it is independently actionable for Luna, contains
no same-receiver semantic duplicate, and identifies the evidence that lets Root
integrate the result.
