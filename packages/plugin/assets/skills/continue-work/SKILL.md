---
name: continue-work
description: Use when the user asks Root to continue, resume, or keep going with existing HolyCodex work.
---

Recover the current Intent, Plan, Assignments, terminal results, unresolved work,
and material decisions. Reconcile them with the current repository and external
evidence, then continue normal HolyCodex orchestration from the last supported
state. Preserve established ownership, scope, decisions, evidence, and completed
work; do not create a fresh Intent for the same work.

Use `holycodex-agent state diagnose --intent <ref>` only when the available
state cannot otherwise be resumed safely. Resolve a recoverable inconsistency
through the owning state operation, or return the exact blocker to Root. A
continuation request does not turn an active Assignment into a failed one
without evidence that its invocation stopped.
