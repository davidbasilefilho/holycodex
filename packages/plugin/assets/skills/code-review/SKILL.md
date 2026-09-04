---
name: code-review
description: Use once after code or manifest implementation when Root needs adversarial review and bounded repair to a fixed point.
---

Use this skill once after implementation or manifest work. Inspect the actual
integrated result to a fixed point before Root judges readiness. Apply
[testing quality](../testing-quality.md) when judging new or modified tests.

Inspect the assigned diff, callers, contracts, tests, compatibility, and
artifact. Repair defects inside the review surface, verify each repair, and
repeat until the review reaches a fixed point.

Flag speculative abstractions, pointless file splits, oversized changes,
unclear dependency direction, and tests that protect implementation detail.
Confirm incidental generated output is absent before stopping.
