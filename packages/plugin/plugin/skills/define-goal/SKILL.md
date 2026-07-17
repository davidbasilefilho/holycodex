---
name: define-goal
description: Use when the user asks to define a goal or explicitly accepts a goal offered after planning or frontend approval; do not infer consent from implementation or vague improvement language. Creates or reuses one bounded measurable goal with proof and a hard stop; unlike plan, it defines completion rather than steps.
---

# Define Goal

On activation, first user-visible line must be:

**GOAL MODE ACTIVATED**
I detect goal-definition intent — [reason]. [action].

Create one bounded, verifiable objective; no plan, log, snapshot, ledger, handoff, or continuation mandate.

## Flow

1. State concrete outcome, target, completion criteria, proof, scope, exclusions, input blocker, and stop condition.
2. Add useful checks, paths, environments, counts, or limits; no fake precision or quality ratchet.
3. Replace activity goals such as “improve” with observable state. Bound subjective quality by approved task and named validator.
4. Ask one short question only if missing scope or proof would materially change intent.
5. Call `get_goal`.
   - No goal: quality-check, then `create_goal`.
   - Same active goal: reuse.
   - Conflicting goal: ask whether to finish it or use another task.
6. Call `create_goal` with one concise objective. Set token budget only when explicitly requested. Stop when criteria pass; do not extend for polish, speculation, repeated review, adjacent work, or new opportunities.

## Quality gate

Objective must answer:

- What becomes true?
- What exact evidence proves it?
- What binary or numeric threshold defines success?
- What is in and out?
- What condition requires user input?
- What exact condition ends work even if further improvement is possible?

Good validators: failing-then-passing bug test; exact test command; measured performance threshold; cited research decision; healthy operation plus rollback threshold.
