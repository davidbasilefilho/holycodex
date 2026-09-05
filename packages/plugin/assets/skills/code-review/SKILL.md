---
name: code-review
description: Use once after code or manifest implementation when Root needs adversarial review and bounded repair to a fixed point.
---

Owner: Reviewer within one delegated Assignment. Root must dispatch this skill
after implementation or manifest work and record its structured result through
`holycodex-agent assignment result`; the Reviewer never owns global lifecycle,
material decisions, or Git/VCS. Inspect the actual integrated result to a
fixed point before Root judges readiness. Apply
[testing quality](../testing-quality.md) when judging new or modified tests.

Read the Assignment and current Intent through the semantic agent interface;
do not edit TOON files manually.

This fixed-point review is mandatory after implementation or a major codebase
change and must pass before Intent completion or any VCS operation. Apply the
repository surgical-mutation rule from `AGENTS.md` to reviewer repairs.

Inspect the assigned diff, callers, contracts, tests, compatibility, and
artifact. Repair defects inside the review surface, verify each repair, and
repeat until the review reaches a fixed point.

Return `completed`, `blocked`, `needs_root_input`, or `failed` with findings,
repaired paths, verification, and residual risk. Flag speculative
abstractions, pointless file splits, oversized changes,
unclear dependency direction, and tests that protect implementation detail.
Confirm incidental generated output is absent before stopping.
