---
name: debugging
description: Reproduce, isolate, prove, and minimally fix runtime bugs. Use for crashes, wrong behavior, hangs, races, leaks, or unexplained performance.
---

# Debugging

No guess-fix loop.

1. Reproduce exact symptom with smallest command.
2. Minimize input, environment, and path.
3. Write at least three plausible causes from distinct layers.
4. Rank by evidence and cheap falsifier.
5. Instrument narrow boundary. Capture values, ordering, ownership, timing, process state.
6. Disprove causes. After two failed rounds, change angle; do not add reviewer or oracle agent.
7. Confirm root cause with evidence that predicts symptom.
8. Add failing public-behavior regression test.
9. Make minimum root fix.
10. Run targeted test, then proportional suite. Remove temporary instrumentation.

No sleeps for async proof. Use event, signal, fake clock, trace, debugger, profiler, sanitizer, or deterministic fixture. No implementation before root cause unless user explicitly asks for mitigation.

Load only relevant runtime/tool reference under `references/`. Report reproduction, hypotheses rejected, root cause, proof, fix, checks, residual uncertainty.
