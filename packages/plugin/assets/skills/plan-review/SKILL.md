---
name: plan-review
description: Use when Root has a complete plan that needs adversarial review; check feasibility, order, risk, and proof to a fixed point.
---

Owner: Reviewer. Boundary: inspect the complete Plan once to a fixed point;
repair only reviewer-owned plan defects. Return material product or
architecture choices to Root. Root must delegate this review as an Assignment
and record its structured result through `holycodex-agent assignment result`.

Read the current Plan with `holycodex-agent plan read`; never edit TOON files
directly. A revision is a semantic `plan revise` operation that archives the
prior canonical Plan before replacement.

Apply the repository surgical-mutation rule to any repair. If a material
choice is unresolved, return `needs_root_input` rather than deciding it.

Return `completed`, `blocked`, `needs_root_input`, or `failed` with findings,
proof, and remaining risk; Root records that outcome on the Assignment.

Completion: the plan is complete with proof, blocked with evidence, or
explicitly needs a Root decision.
