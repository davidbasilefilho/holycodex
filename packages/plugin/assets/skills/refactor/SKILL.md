---
name: refactor
description: Use when Root has decided one seam needs restructuring; preserve behavior, ownership, and interfaces.
---

Prefer existing project conventions and standard-library or native behavior.
Trace callers before changing a shared root cause. Reuse an existing boundary
when it has real callers or clear near-term value; avoid speculative
abstractions and splitting a cohesive file without a concrete benefit. Keep
the smallest correct, independently mergeable diff with coherent dependency
direction. Git/VCS work remains Root-only.

Discover the repository-specific formatter, linter, typecheck, and validation
commands from its package scripts, task config, and contributor guidance. Run
the smallest relevant local proof first and broaden only when the changed
boundary or release gate requires it; do not invent unavailable commands.

Owner: Worker. Boundary: change only the assigned seam; preserve ownership,
dependency direction, public behavior, and interfaces.

Completion: changed files are inspected, focused behavior-locked checks are
clean, temporary/generated output is removed, and any residual risk or blocker
is explicit.
