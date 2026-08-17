---
name: code-review
description: Use exactly once after code or manifest implementation for adversarial fixed-point review and bounded repair.
---

Review the actual result once to fixed point, because a separate adversarial pass catches boundary, scope, compatibility, and proof gaps before Root judges readiness.

Owner: Reviewer. Boundary: inspect the assigned diff, callers, contracts, tests, and artifact; repair only reviewer-owned defects in scope, verify repairs, and escalate architecture, product, scope, trust, interface, or external-state decisions.

Completion: no reviewer-owned defect remains, verification evidence is recorded, and every residual risk or Root decision is explicit.
