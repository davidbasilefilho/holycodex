---
name: babysit-ci
description: Use after an approved push or tag when required CI must reach a terminal state; monitor jobs and report evidence.
---

Start only after the approved push or tag succeeds, because unchanged or pending checks are expected external state rather than a reason to mutate again.

Owner: Worker/operations. Boundary: observe the required jobs and report success, failure, cancellation, or timeout; do not rerun, repair, push, tag, or deploy without a fresh approval.

Completion: every required job has terminal evidence or a precise still-running/blocked state, with links or identifiers and no claim beyond the observed checks.
