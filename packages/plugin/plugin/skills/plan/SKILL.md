---
name: plan
description: Use when the user asks for a plan or implementation requires unresolved architecture, cross-cutting coordination, irreversible decisions, high risk, or material ambiguity; do not use for multiple obvious steps, simple direct work, status, or explanation. Produces one repo-grounded reviewed plan with approval and optional goal gates; unlike plan-review, it owns the full planning sequence.
---

# Plan

On activation, first user-visible line must be:

**PLAN MODE ACTIVATED**
I detect planning intent — [reason]. [action].

Root owns architecture, initial plan, review integration, decisions, and approval. It may delegate bounded repository facts or current primary-source research when cost is lower, but never the plan, review judgment, user clarification, or approval. Use no reviewer agent, evidence directory, commit ritual, or ceremony.

## Required sequence

1. Load `plan`; perform cost-aware decomposition and inspect enough task and repo context.
2. Write the complete initial plan. Each ordered step names the relevant file or surface, exact change, expected outcome, and smallest proof; mark only material dependencies, risks, and user decisions.
3. Only after the initial plan exists, load `plan-review`. Never preload, parallelize, delegate, or imply its review.
4. Use `plan-review` once to revise or rewrite the initial plan. Keep initial and reviewed phases distinct.
5. Present the reviewed executable plan and ask for approval. Do not implement before approval.
6. After approval, ask whether the user wants to define a goal.
7. Only after explicit agreement, load `define-goal`; otherwise implement the approved plan.

Preserve architecture and requested scope. Stop planning after approval and the optional goal choice; no repeated review or polishing loop.
