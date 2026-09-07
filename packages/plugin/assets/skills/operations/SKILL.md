---
name: operations
description: Use for exact-ref CI or release observation through terminal evidence.
---

Observe the exact approved ref and SHA after Root's VCS action. Discover
whether the repository has separate development and release gates, one combined
pipeline, or no formal separation. Report terminal green, terminal failure, or
an exact unavailable or ambiguous blocker. Pending and running are not success.
Do not rerun, cancel, approve, merge, push, tag, publish, deploy, or otherwise
mutate external state.

Root dispatches this procedure to `Worker.operations` with the exact ref and
SHA. Include target-branch or pull-request mergeability evidence when the
repository or provider exposes it; green CI alone does not prove mergeability.
Root does not observe terminal operations locally.
