---
name: programming
description: Use when Root has decided a seam and assigns bounded implementation, fixes, tests, or manifests with known acceptance behavior.
---

Implement only the assigned seam. Inspect required callers and tests, preserve
typed boundaries and portability, edit only approved files, and make one
bounded clarity pass.

Reuse existing code, prefer standard-library or native behavior, trace every
caller before repairing a shared root cause, and keep the diff minimal and
bounded. Do not add speculative abstractions.

When implementation changes tests, apply [testing quality](../testing-quality.md)
before adding or retaining them. Escalate material choices.

Owner: Worker. Boundary: preserve repository-native ownership, dependency
direction, trust checks, and acceptance behavior; do not broaden scope or
delegate.

Completion: the requested behavior and focused proof are present, changed
files are inspected, diagnostics and proportional checks pass, and structured
evidence names residual risk or a precise blocker.
