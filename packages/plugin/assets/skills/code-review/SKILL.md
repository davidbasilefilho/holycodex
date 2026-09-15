---
name: code-review
description: Use after implementation when Root needs adversarial code review and bounded repair to a fixed point.
---

Inspect the integrated implementation against the receiver-visible `Reviewer.code`
contract. Check callers, contracts, tests, and generated artifacts. Repair
defects inside the review surface and return the findings, repairs, checks, and
remaining risk.

Lead with actionable findings and check evidence. Keep the terminal report
concise and structured, reuse stable facts, and inspect large artifacts only
when a material decision, conflict, failure, or finding requires it.

Root dispatches this procedure to the mandatory native `Reviewer.code` route
after implementation or a major code change and before completion or VCS. The
canonical receiver contract owns the quality and mergeability criteria; this
skill supplies only the review procedure. Root does not perform code review or
repair locally.

The canonical phase barrier is implementation leaves terminal, then the
`Reviewer.code` fixed point, then `Worker.validation`, then Root integration and
VCS. Reuse the Assignment evidence across those phases and return control to
Root for acceptance, CI gates, and repository mutation.
