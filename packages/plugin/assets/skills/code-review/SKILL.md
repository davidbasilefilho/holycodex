---
name: code-review
description: Use after implementation when Root needs adversarial code review and bounded repair to a fixed point.
---

Inspect the integrated implementation against the `Reviewer.code` contract.
Check callers, contracts, tests, and generated artifacts. Repair defects inside
the review surface and return findings, repairs, checks, and remaining risk.

Use one batched evidence sweep, reason over it, make targeted follow-ups only,
and batch related repairs and verification.

Lead with actionable findings and check evidence. Keep the terminal report
concise and structured, reuse stable facts, and inspect large artifacts only
when a material decision, conflict, failure, or finding requires it.
