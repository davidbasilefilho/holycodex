---
name: code-review
description: Use after implementation when Root needs adversarial code review and bounded repair to a fixed point.
---

Inspect the integrated implementation against the receiver-visible `Reviewer.code`
contract. Check callers, contracts, tests, and generated artifacts. Repair
defects inside the review surface and return the findings, repairs, checks, and
remaining risk.

Root dispatches this procedure to the mandatory native `Reviewer.code` route
after implementation or a major code change and before completion or VCS. The
canonical receiver contract owns the quality and mergeability criteria; this
skill supplies only the review procedure. Root does not perform code review or
repair locally.
