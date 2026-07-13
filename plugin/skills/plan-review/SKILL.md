---
name: plan-review
description: Use when a complete initial implementation plan needs feasibility, scope, sequencing, risk, or verification repair, including the required review phase of the plan skill; do not use before initial drafting or as a recurring reviewer. Produces one repaired executable plan; unlike plan it does not own drafting or approval.
---

# Plan Review

On activation, first user-visible line must be:

**PLAN REVIEW ACTIVATED**

Input must include the request, complete initial plan, and enough repo facts. If no initial plan exists, stop and return control to `plan`; never draft its first plan.

One pass:

1. Test feasibility and compatibility with repo architecture and user constraints.
2. Find missing steps, dependencies, risks, ambiguities, unsafe mutations, weak completion criteria, and unverifiable outcomes.
3. Remove unnecessary work, ceremony, scope expansion, duplicate checks, and poor sequencing.
4. Strengthen each step's target, change, dependency, proof, and stop condition.
5. Revise or rewrite directly; preserve sound content. Output one complete reviewed plan, not comments or scores.

No reviewer agent, evidence folder, second review loop, or implementation. Stop after the corrected executable plan; `plan` owns presentation and approval.
