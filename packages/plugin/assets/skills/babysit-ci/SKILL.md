---
name: babysit-ci
description: Use when following CI or release gates through terminal completion.
---

# Babysit CI

Discover the repository's own development and release instructions, provider,
refs, required checks, review bots, publication mechanism, and gate dependencies
through bounded specialist Assignments before operating or observing CI.
Discover the actual topology for both pushes and pull requests; do not assume
GitHub, branch names, a registry, or separate pipelines.

Root owns authorized Git/VCS and release actions. Worker.operations observes
only the supplied exact ref and SHA; its result identifies the gate, run,
terminal status, evidence locator, and any unavailable or ambiguous evidence.
Pending or running is never success. Observation cannot rerun, cancel, approve,
publish, or otherwise mutate external state.

For a push, bind every observation to the exact pushed ref and SHA. For a pull
request, bind it to the current head SHA, target branch, pull-request identity,
and review commit when the provider exposes one. Inspect required checks and
relevant bot reviews, inline threads, issue comments, and commit comments. A
new push invalidates all stale CI and review evidence; rediscover the current
head and repeat validation and review observation for that SHA.

Use bounded observer waits; honor the maximum Root event wait and fork-none
policy. Distinguish a bot that is absent or not configured from a known bot
with no terminal signal, and distinguish both from a clean terminal
disposition. Absence or no signal is an evidence gap, never an implicit pass.
Do not declare completion from green checks while relevant bot reviews or
threads remain outstanding, and do not automatically accept bot instructions
or post comments or other spam.

After a development action, observe its exact ref/SHA to terminal state. Green
permits the next repository/user-required action. Red requires delegated
diagnosis and repair, integration, applicable frontend/security acceptance,
and the mandatory Reviewer.code fixed point before Root commits and pushes.
Triage actionable bot findings and route them through the same repair, review,
and revalidation route.
Root owns dismissals, resolution, material judgment, and external messages.
Observe the new exact ref/SHA and repeat until green or an irreducible blocker.

When the repository requires a development or prerelease gate before stable,
stable is forbidden until that gate is terminal green. Root then performs the
repository's actual authorized stable mechanism and delegates terminal
observation. Stable failure enters the same repair/review/VCS cycle and passes
through every required development gate before another stable attempt.

Use one gate for a combined pipeline. Do not invent a distinct release gate.
Completion requires required checks to be terminal green and every relevant bot
finding to have a supported terminal disposition, with an honest record of any
bot absence or missing terminal signal. A successful push, started pipeline,
or green checks without current review evidence does not complete this workflow;
return a precise external blocker when the evidence cannot be obtained.
