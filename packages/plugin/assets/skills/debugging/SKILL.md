---
name: debugging
description: Use when Root assigns a reproducible crash, wrong result, regression, hang, race, leak, or slowdown; isolate and prove the narrow repair.
---

Reproduce the defect before changing code. A stable red case distinguishes
cause from symptom and makes the repair checkable.

Owner: Worker within one delegated Assignment. Boundary: capture the smallest
failing input and trace, form an evidence-backed cause, apply the narrow fix,
and preserve unrelated behavior. Escalate competing causes or material
redesign. Root creates/starts the Assignment and records the result through
`holycodex-agent assignment result`; the Worker must not mutate Intent state or
edit TOON files manually.

Apply the repository surgical-mutation rule from `AGENTS.md`.

Discover and use the repository-specific formatter, linter, typecheck, and
validation commands before and after the repair. Start with the smallest
relevant local proof and expand only when the defect crosses that boundary or
the release gate requires it; report unavailable commands rather than
inventing replacements.

Return one outcome from `completed`, `blocked`, `needs_root_input`, or
`failed`, including reproduction, cause, repair proof, and remaining
uncertainty. Completion requires the failure to be reproduced, the cause to be
supported by repository evidence, and the fix and regression proof to pass.
