---
name: handoff
description: Use when current Intent state must be resumed or exported; write a portable Markdown handoff with evidence and next action.
---

Write one compact Markdown handoff file in the host temporary directory resolved through environment variables such as TMPDIR, TMP, or TEMP. Avoid hardcoded absolute machine or user paths. Include current Intent, Plan, and Assignment status, evidence, blockers, remaining risk, and the exact next action. Omit secrets, raw prompts, transcripts, and unchanged narration. The semantic state remains authoritative.

Verify the file contains sufficient context to resume the work. Return its portable location relative to the resolved temporary directory in a Markdown code block, identifying the temporary environment variable used. Let the user decide how to use it; do not create another thread.
