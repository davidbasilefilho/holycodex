---
name: define-goal
description: Define or refine one measurable goal before work. Use only when explicitly asked to set, create, quantify, or clarify a goal.
---

# Define Goal

On activation, first user-visible line must be:

**GOAL MODE ACTIVATED**

Turn intent into one bounded, verifiable objective. No plan, log, snapshot, ledger, or handoff.

## Flow

1. State outcome, target, proof, scope, exclusions, stop condition.
2. Add meaningful thresholds: exact checks, paths, environments, counts, limits. No fake precision.
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
