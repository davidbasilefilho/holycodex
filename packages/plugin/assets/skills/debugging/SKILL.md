---
name: debugging
description: Use for a reproducible crash, wrong result, regression, hang, race, leak, or slowdown with an observable failing case.
---

Reproduce the defect before changing code, because a stable red case distinguishes cause from symptom and makes the repair checkable.

Owner: Worker within the assigned seam. Boundary: capture the smallest failing input and trace, form an evidence-backed cause, apply the narrow fix, and preserve unrelated behavior; escalate competing causes or material redesign.

Completion: the failure is reproduced, the cause is supported by repository evidence, the fix and regression proof pass, and remaining uncertainty is recorded.
