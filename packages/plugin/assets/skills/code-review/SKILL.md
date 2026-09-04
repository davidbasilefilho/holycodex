---
name: code-review
description: Use once after code or manifest implementation when Root needs adversarial review and bounded repair to a fixed point.
---

Use this skill once after implementation or manifest work. Inspect the actual
integrated result to a fixed point before Root judges readiness. Apply
[testing quality](../testing-quality.md) when judging new or modified tests.

Owner: Reviewer. Boundary: inspect the assigned diff, callers, contracts,
tests, compatibility, and artifact. Repair only reviewer-owned defects inside
scope, verify each repair, and repeat until no assigned defect remains. Root
retains architecture, product, scope, trust, interface, external-state, and
final readiness decisions.

Use existing code and project conventions before adding code; prefer
standard-library or native behavior; trace callers before judging a shared root
cause; and flag speculative abstractions, pointless file splits, oversized or
unmergeable diffs, unclear dependency direction, and unnecessary tests.
Check that temporary/generated output is absent and Git/VCS remains Root-only.

Completion: no reviewer-owned defect remains, verification evidence is
recorded, and every residual risk or Root decision is explicit.
