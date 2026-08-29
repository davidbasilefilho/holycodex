---
name: writing-for-agents
description: Use when authoring or reviewing instructions consumed by agents, including prompts, skills, profiles, delegations, handoffs, and workflows.
---

# Writing for agents

Treat instructions as a small interface, not a role description. Start with one contract:

Owner: the authoring role within its approved scope.
Boundary: keep policy in one source of truth and return material decisions to the owning agent.
Completion: the receiving agent can act, prove, and stop from this instruction alone.

- **Objective and outcome:** what must be true when the assignment ends.
- **Scope and authority:** exact files or decisions in scope, and who owns everything else.
- **Constraints:** retained policy, tools, security, and non-goals.
- **Evidence and completion:** the output shape, proof required, and the condition that permits stopping.
- **Escalation:** the precise missing fact or conflict that returns to the owning agent.

Write each behavior beside its reason when the reason changes a decision. Prefer direct positive steering, one source of truth, and pointers to branch-only detail. Remove duplicate policy, stale context, no-op prose, and instructions the environment already enforces. Keep a resumed assignment to its changed constraints and delta; do not replay the whole contract.

For Sol, state invariants and decision boundaries. For Luna, name the exact files or actions, evidence fields, authority limit, and stop condition; do not leave operational choices implicit. Keep dynamic assignments short enough to preserve working context.

Use the narrowest route: `programming` for implementation, `code-review` once after implementation, `workflows` for substantive orchestration, `context7-cli` for current external documentation, and `handoff` when context must pause or transfer. Read the selected route's skill only after choosing it.

Completion means the instruction is independently actionable, triggerable at the right branch, explicit about exclusions and escalation, and testable through the receiver's output. Adapted from the supplied Matt Pocock skills-writing concepts.
