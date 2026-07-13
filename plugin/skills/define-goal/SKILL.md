---
name: define-goal
description: Use to define one measurable goal when explicitly asked to set or refine one.
---

# Define Goal

On activation, first user-visible line must be:

**GOAL MODE ACTIVATED**

Create one bounded, verifiable objective; no plan, log, snapshot, ledger, or handoff.

## Flow

1. State outcome, target, proof, scope, exclusions, stop condition.
2. Add useful checks, paths, environments, counts, or limits; no fake precision.
3. Replace activity goals like “improve” with observable state.
4. Ask one short question only if missing scope or validator changes intent.
5. Call `get_goal`.
   - No goal: quality-check, then `create_goal`.
   - Same active goal: reuse.
   - Conflicting goal: ask whether to finish it or use another task.
6. Call `create_goal` with one concise objective. Set token budget only when user explicitly asks.

## Quality gate

Objective must answer:

- What becomes true?
- What exact evidence proves it?
- What binary or numeric threshold defines success?
- What is in and out?
- What condition requires user input?

Good validators: failing-then-passing bug test; exact test command; measured performance threshold; cited research decision; healthy operation plus rollback threshold.
