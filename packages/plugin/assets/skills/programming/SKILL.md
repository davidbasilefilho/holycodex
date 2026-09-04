---
name: programming
description: Use when Root has decided a seam and assigns bounded implementation, fixes, tests, or manifests with known acceptance behavior.
---

Implement only the assigned seam. Inspect required callers and tests, preserve
typed boundaries and portability, edit only approved files, and make one
bounded clarity pass.

Prefer existing project conventions and standard-library or native behavior.
Trace every caller before repairing a shared root cause. Reuse an existing
boundary when it has real callers or clear near-term value; do not add
speculative abstractions or split a cohesive file without a concrete benefit.
Keep the smallest correct, independently mergeable diff with deliberate error
handling and sensible dependency direction. Git/VCS work remains Root-only.

Before checking a change, discover the repository's own formatter, linter,
typecheck, and validation commands from its package scripts, task config, and
contributor guidance. Run the smallest relevant local command first, then
broaden only when the changed boundary or release gate requires it; report
which commands were unavailable instead of inventing replacements.

When implementation changes tests, apply [testing quality](../testing-quality.md)
before adding or retaining them: protect a meaningful stable behavior at the
least brittle observable boundary, and avoid tests for implementation detail.
Remove temporary or incidental generated output before handoff. Escalate
material choices.

Owner: Worker. Boundary: preserve repository-native ownership, dependency
direction, trust checks, and acceptance behavior; do not broaden scope or
delegate.

Completion: the requested behavior and focused proof are present, changed
files are inspected, diagnostics and proportional checks pass, and structured
evidence names residual risk or a precise blocker.
