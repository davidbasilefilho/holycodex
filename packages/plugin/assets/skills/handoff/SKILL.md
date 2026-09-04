---
name: handoff
description: Use when a caller needs a redacted projection of current Intent state for resume or export.
---

Handoff is a projection/export only, not persistent workflow state. Read the
current Intent, Plan, and Assignments through `holycodex-agent`; never create a
handoff file or duplicate lifecycle, owner, blocker, evidence, or resume state.

Owner: Root. Boundary: request a compact redacted projection containing the
current Intent reference, Plan revision, Assignment statuses, evidence,
blockers, remaining risk, and exact next action; omit secrets, raw prompts,
transcripts, and unchanged narration. The authoritative state remains under
`.holycodex/{slug}-{short-id}/` and all mutations use semantic agent CLI
operations.

Completion: one bounded, redacted projection is ready for the receiving owner;
no second source of truth exists.
