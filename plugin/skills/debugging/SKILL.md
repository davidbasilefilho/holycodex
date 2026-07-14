---
name: debugging
description: Use when a task involves a crash, wrong result, hang, race, leak, slowdown, or other reproducible defect that needs root-cause proof; do not use for feature work, behavior-preserving refactors, or speculative cleanup. Produces reproduction, evidence, regression proof, and an authorized minimal fix; unlike programming it owns symptom-to-cause diagnosis.
---

# Debugging

No guess-fix loop.

1. Reproduce exact symptom with smallest command.
2. Minimize input, environment, and path.
3. List three plausible cross-layer causes; rank by evidence and cheapest falsifier.
4. Instrument narrow boundary. Capture values, ordering, ownership, timing, process state.
5. Disprove causes. Change angle after two failed rounds; add no reviewer or oracle agent.
6. Confirm root cause with evidence that predicts symptom.
7. Add failing public-behavior regression test.
8. Make minimum root fix.
9. Run targeted test, then proportional suite. Remove temporary instrumentation.

No sleeps for async proof; use deterministic events, clocks, traces, debuggers, profilers, sanitizers, or fixtures. Do not implement before proving cause unless user requests mitigation.

Load only relevant runtime/tool reference under `references/`. Report reproduction, hypotheses rejected, root cause, proof, fix, checks, residual uncertainty.
