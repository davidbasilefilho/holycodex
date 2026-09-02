---
name: refactor
description: Use when Root has decided one seam needs restructuring; preserve behavior, ownership, and interfaces.
---

Reuse existing code and prefer standard-library or native behavior. Trace
callers before changing a shared root cause, keep the diff minimal and
bounded, and avoid speculative abstractions.

Owner: Worker. Boundary: change only the assigned seam; preserve ownership,
dependency direction, public behavior, and interfaces.

Completion: changed files are inspected and behavior-locked checks are clean,
with any residual risk or blocker explicit.
