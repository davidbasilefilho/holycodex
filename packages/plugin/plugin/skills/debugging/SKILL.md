---
name: debugging
description: Use for a reproducible crash, wrong result, failing test, regression, hang, race, leak, slowdown, or other defect; do not use for features, refactors, or speculative cleanup. Produces a root cause, regression proof, and minimum authorized fix.
---

# Debugging

No guess-fix loop.

1. Reproduce exact symptom with smallest command; minimize input, environment, path.
2. List three plausible cross-layer causes ranked by evidence/cheapest falsifier.
3. Instrument narrow boundary: values, order, ownership, timing, process state.
4. Disprove causes; change angle after two failed rounds. No reviewer/oracle.
5. Confirm cause with evidence predicting symptom.
6. Add failing public-behavior regression test; make minimum root fix.
7. Run targeted then proportional tests; remove probes.

No sleeps for async proof: use deterministic events/clocks/traces, debugger, profiler, sanitizer, fixtures. Do not implement before proof unless mitigation is requested. Load only relevant runtime/tool reference under `references/`. Report reproduction, rejected hypotheses, cause/proof, fix/checks, residual uncertainty.
