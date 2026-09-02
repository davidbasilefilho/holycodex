---
name: babysit-ci
description: Use after Root approves an exact-ref or SHA push or tag when required CI or release observation must reach terminal state; report evidence.
---

Use this skill after the approved exact ref or SHA mutation succeeds. Observe
the required CI jobs and release state through terminal evidence; pending or
running checks are incomplete, not success.

Owner: Worker/operations. Boundary: observe only the approved exact ref or
SHA and its required checks. Report success, failure, cancellation, timeout,
or a still-running blocker. Do not rerun, repair, push, tag, deploy, or change
external state without fresh Root approval.

Completion: every required job and release step has terminal evidence, or the
outcome is explicitly incomplete with exact identifiers, links, and current
state.
