---
name: refactor
description: Use when Root has decided one seam needs restructuring; preserve behavior, ownership, and interfaces.
---

Owner: Worker within one delegated Assignment. Read the current Assignment
through the semantic agent interface; do not edit TOON files manually. Restructure
only the decided seam. Trace its callers before changing a shared root cause,
preserve public behavior and interfaces, and keep the smallest cohesive change.

Apply the repository's surgical-mutation rule: make the smallest complete edit
set within the authorized boundary, touch no unrelated paths, avoid speculative
refactors or formatting churn, and perform no redundant writes or operations.
Preserve unrelated work and stop for Root input before expanding scope.

Discover the repository's own validation commands and run the smallest relevant
behavior-locked check first; broaden when the changed boundary or release gate
requires it. Inspect changed files and remove incidental generated output
before stopping.

Return one outcome from `completed`, `blocked`, `needs_root_input`, or `failed`,
with changed paths, checks and results, evidence, and remaining risk. The Worker
does not mutate global Intent lifecycle, make material decisions, or perform
Git/VCS; Root records the result through `holycodex-agent assignment result`.
