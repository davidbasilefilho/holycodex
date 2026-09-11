---
name: babysit-ci
description: Use when following CI or release gates through terminal completion.
---

# Babysit CI

Discover the repository's own development and release instructions, provider,
refs, required checks, publication mechanism, and gate dependencies through
bounded specialist Assignments before operating or observing CI. Do not assume
GitHub, branch names, pull requests, a registry, or separate pipelines.

Root owns authorized Git/VCS and release actions. Worker.operations observes
only the supplied exact ref and SHA; its result identifies the gate, run,
terminal status, evidence locator, and any unavailable or ambiguous evidence.
Pending or running is never success. Observation cannot rerun, cancel, approve,
publish, or otherwise mutate external state.

After a development action, observe its exact ref/SHA to terminal state. Green
permits the next repository/user-required action. Red requires delegated
diagnosis and repair, integration, applicable frontend/security acceptance,
and the mandatory Reviewer.code fixed point before Root commits and pushes.
Observe the new exact ref/SHA and repeat until green or an irreducible blocker.

When the repository requires a development or prerelease gate before stable,
stable is forbidden until that gate is terminal green. Root then performs the
repository's actual authorized stable mechanism and delegates terminal
observation. Stable failure enters the same repair/review/VCS cycle and passes
through every required development gate before another stable attempt.

Use one gate for a combined pipeline. Do not invent a distinct release gate.
Completion requires all requested terminal-green evidence or a precise external
blocker; a successful push or started pipeline does not complete this workflow.
