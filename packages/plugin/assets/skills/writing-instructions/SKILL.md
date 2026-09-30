---
name: writing-instructions
description: Use when model-facing instructions need authorship or review; make them coherent, scoped, and complete for their receiver.
---

# Writing instructions

Treat every model-facing instruction as an execution contract.

The receiver must be able to determine the goal or required end-state, the observable conditions that constitute success, and the evidence required to prove that success.

Use this mental model:

goal -> success criteria -> optional required method -> proof of success

Identify the receiver's effective context: instruction hierarchy, repository rules, Root or Role.task authority, relevant skills, tools, projected capabilities, configuration, and Assignment facts. Add only missing constraints and resolve contradictions against governing authority.

Give each meaning one authoritative owner. Project policy from that owner instead of duplicating it across prompts, metadata, skills, generated instructions, or nearby policies.

State a required means, procedure, tool, ordering, or implementation detail only when it materially constrains correct execution. Otherwise leave routine safe implementation choices to the receiver.

Completion evidence must prove the success criteria. Use the smallest meaningful proof proportionate to behavior, scope, risk, uncertainty, and acceptance criteria. Reuse current evidence. Broaden or repeat validation only after relevant changes, failures, elevated risk, or unresolved material concerns. Preserve required repository gates and necessary high-risk regression coverage.

Remove redundant policy, stale model scaffolding, broad reading rituals, rigid recipes without a real dependency, hypothetical gates, repeated testing, and prose that merely restates choices the receiver can safely make itself.

Carry authorized work through repair and proof.

Validate the effective contract rather than exact wording: the receiver can identify the goal, recognize success and blockers, act within authority, and return sufficient evidence without contradictory rules.

Keep skill descriptions short and situation-first. Audit triggers alongside nearby skills; keep coherent shared guidance together and link uncommon mechanics from the condition that needs them. Display and invocation metadata selects the workflow; it does not duplicate model-facing behavior. Metadata default prompts invoke the named skill without embedding another instruction source. Preserve upstream attribution.
