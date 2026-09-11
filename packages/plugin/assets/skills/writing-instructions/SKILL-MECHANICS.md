# Skill mechanics

Use a skill for a distinct conditional workflow or tool capability. Keep its
description short and specific enough to distinguish the invocation from nearby
skills. Avoid broad triggers that compete for ordinary work; audit implicit
invocation against the other skills the receiver can load.

Keep the main body focused on the shared outcome, boundaries, and acceptance
criteria. Link branch-specific tool knowledge or uncommon procedures from the
condition that needs them, so only the selected branch loads its detail. Do not
split a short coherent rule merely to create more files.

Keep display and invocation metadata in agents/openai.yaml and behavior in its
single authoritative source. References should supply a missing decision or
mechanic, not copies of the body or global policy. Preserve provenance and
license attribution under the original upstream names when renaming a skill.
