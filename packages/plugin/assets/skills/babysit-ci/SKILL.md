---
name: babysit-ci
description: Use when following CI or release gates through terminal completion.
---

# Babysit CI

Discover the repository's development and release topology for pushes and pull
requests: refs, required checks, reviews, publication mechanism, and gate
dependencies. Do not assume a provider, branch name, or separate pipeline.

For a push, bind every observation to the exact pushed ref and SHA. For a pull
request, bind it to the current head SHA, target branch, pull-request identity,
and review commit when the provider exposes one. Inspect required checks and
relevant bot reviews, inline threads, issue comments, and commit comments. A
new push invalidates all stale CI and review evidence; rediscover the current
head and repeat validation and review observation for that SHA.

Use bounded observer waits. Distinguish a bot that is absent or not configured
from a known bot with no terminal signal, and both from a clean terminal
disposition. Absence or no signal is an evidence gap. Green checks do not
resolve outstanding review findings or threads.

After a development action, observe its exact ref and SHA to terminal state.
Repair failed checks and actionable review findings, then repeat validation and
observation on the new head until green or an irreducible blocker.

When the repository requires a development or prerelease gate before stable,
wait for terminal green before stable. A stable failure enters the same repair
and review cycle, including required development gates before another attempt.

Use one gate for a combined pipeline. Do not invent a distinct release gate.
Completion requires terminal green checks and a supported terminal disposition
for relevant reviews on the current SHA. Return the precise external blocker
when terminal evidence cannot be obtained.
