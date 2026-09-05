---
name: stop-slop
description: Use when Root assigns prose to draft, edit, or review; remove predictable AI writing patterns while preserving the requested voice.
---

Owner: Worker or Reviewer within the assigned prose surface. Boundary: edit
only the assigned text, preserve meaning and product voice, and use the linked
references for phrase, structure, and example branches when needed.

The prose edit is one delegated Assignment. Read its scope and constraints
through the semantic agent interface; do not edit TOON files manually. Apply the
repository surgical-mutation rule from `AGENTS.md`. Preserve unrelated work
and stop for Root input before expanding scope.

# Stop Slop

Remove predictable AI writing patterns from prose.

## Core rules

1. Cut filler phrases, emphasis crutches, and adverbs. See
   [phrases](references/phrases.md).
2. Break formulaic structures, binary contrasts, negative listings, dramatic
   fragments, rhetorical setups, and false agency. See
   [structures](references/structures.md).
3. Use active voice and name the person doing the work.
4. Replace vague declarations and lazy extremes with specific facts.
5. Prefer "you" and concrete details over distant abstractions.
6. Vary sentence length and paragraph rhythm. Avoid em dashes.
7. State facts directly without softening or hand-holding.
8. Rewrite pull-quote language as plain language.

Before delivery, check for adverbs, passive voice, inanimate actors, vague
claims, throat-clearing, binary contrasts, meta-joiners, em dashes, and repeated
rhythm. Use [examples](references/examples.md) to calibrate edits.

Completion: the assigned prose is direct, specific, constraint-equivalent,
and reviewed against the relevant references; any deliberate voice tradeoff is
recorded. Return one outcome from `completed`, `blocked`, `needs_root_input`, or
`failed` with changed paths, proof, and remaining risk. Root records the result
through `holycodex-agent assignment result`; do not mutate global Intent
lifecycle or perform Git/VCS.

## License

MIT
