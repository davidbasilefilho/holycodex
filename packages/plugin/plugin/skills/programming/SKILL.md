---
name: programming
description: Use when a task changes code or its manifests; do not use for prose-only edits. Applies general correctness, reuse, typing, testing, size, and verification rules plus available language references.
---

# Programming

Before editing code, load `references/<language>/README.md` when present. Otherwise apply only these general rules; never claim unsupported language rules. Load `references/logging.md` only for logs and all `references/rust-ub/` for Rust unsafe or FFI.

## Core

- Prefer no code, existing helper, standard API, native feature, installed dependency, one line, then new code.
- Trace flow and callers; fix the shared root seam once.
- Parse untrusted input at the boundary. Keep interiors typed, states valid, data immutable by default, and variants exhaustive.
- Use typed errors. Catch only expected errors; unknown errors propagate.
- Keep the project stack and logger. Add no untyped escape or ignored diagnostic.

## Reuse

- One behavior, one implementation. Search before writing; reuse or extend the existing implementation.
- Never copy logic or maintain parallel policy variants. Put shared behavior at its smallest stable common ownership seam.
- Extract real repetition; reject speculative abstraction.
- A one-caller helper is justified by a stable domain abstraction, cohesive state transition, protocol boundary, framework requirement, or clearer code; otherwise keep mechanics local.

## Test

Defect: add a public-seam regression test first and confirm the intended failure. For explicit test-first work or defined new behavior lacking proof, test the public seam, confirm failure, implement minimum green, then refactor. Existing tests may lock small covered changes. Do not force red-green for prose, configuration-only work, trivial mechanical edits, or covered behavior. Prefer real objects or fakes; use deterministic fixtures, never sleep. Run the smallest test in the loop.

## Size

Prefer pure functions below 200 LOC; review 200–250 and split above 250 when responsibilities separate cleanly. Keep cohesive state machines, protocol adapters, generated structures, performance-critical code, framework structure, and stable domain abstractions intact when splitting reduces clarity. Prefer a named input object above three independent parameters unless a stable API, protocol, performance constraint, or clearer call justifies separate values.

## Finish

Run formatter, linter, strict type checker, targeted tests, then proportional broader checks. Review responsibility, typed boundaries, exhaustive variants, reuse, regression proof, logging, and user-work preservation. Stop at requested scope.
