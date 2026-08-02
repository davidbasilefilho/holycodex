---
name: programming
description: Use when a task changes code or manifests; do not use for prose-only edits. Applies implementation rules, then hands final audit/repair/verification to code-review.
---

# Programming

Before edits, load present `references/<language>/README.md`; otherwise claim only general rules. Load `references/logging.md` only for logs and all `references/rust-ub/` for Rust unsafe/FFI.

This skill owns implementation. After code/manifest work, Root loads `code-review` exactly once before final response; it owns final audit, repairs, commands/checks/reruns, diff/status, judgment/result. Never delegate review or treat Worker proof as final. `plan-review` repairs pre-approval plans. Prose/docs-only work, status/explanation/planning skip `code-review` unless explicit.

## Core

- Prefer: no code, existing helper, standard API, native feature, installed dependency, one line, new code.
- Trace flow/callers; fix shared root seam once.
- Parse untrusted boundaries; keep interiors typed, valid, immutable by default, exhaustive.
- Use typed errors; catch expected, propagate unknown. Keep project stack/logger; no untyped escape or ignored diagnostic.

## Reuse

One behavior, one implementation: search, reuse/extend, never copy logic/parallel policy. Share at smallest stable owner. Extract actual repetition, not speculative abstraction. One-caller helpers require stable domain abstraction, cohesive transition, protocol/framework boundary, or clearer code.

## Test

For defects/unproved behavior, add public-seam test, confirm intended failure, implement minimum green, refactor. Existing tests may lock covered changes. Do not force red-green for prose/config, trivial mechanics, or covered behavior. Prefer real objects/fakes, deterministic fixtures, no sleeps; run smallest loop test.

## Size

Prefer pure functions under 200 LOC; review 200–250, split above 250 when responsibilities separate. Keep cohesive state machines, protocol adapters, generated/performance/framework structures, stable domain abstractions when splitting hurts clarity. Above three independent parameters prefer named input unless API/protocol/performance/clarity favors separate values.

## Finish

Finish scope, preserve user work, record results/constraints, hand off once to `code-review`; never claim final audit/verification here.
