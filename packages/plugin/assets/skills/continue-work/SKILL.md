---
name: continue-work
description: Use when the user asks Root to continue, resume, or keep going with existing HolyCodex work.
---

Restore the current Intent, Plan if present, Assignments, accepted evidence,
decisions, completed work, and unresolved work. Reconcile that state with the
current repository and continue normal HolyCodex orchestration from the last
supported point; do not restart the same work as a new Intent.

Use `holycodex-agent state diagnose --intent <ref>` only when safe continuation
cannot be established from the available state and current evidence. Resolve a
recoverable inconsistency through its owning state operation, or return the
exact blocker to Root. An active Assignment is not failed without evidence that
its invocation stopped.
