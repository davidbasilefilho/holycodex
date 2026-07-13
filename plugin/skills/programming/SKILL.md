---
name: programming
description: Strict Python, Rust, TypeScript, and Go implementation. Use whenever creating or changing .py, .pyi, .rs, .ts, .tsx, .mts, .cts, or .go files.
---

# Programming

Use for `.py`, `.pyi`, `.rs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.go`, or matching project manifest.

Before code, read language `references/<language>/README.md`; load only linked topic needed. Read `references/logging.md` only when touching logs. Rust unsafe/FFI also loads all `references/rust-ub/`.

## Core

- Best code: none, existing helper, standard API, native feature, installed dependency, one line, then new code.
- Trace real flow and callers. Fix shared root seam once.
- Parse untrusted input once at boundary. Interior stays typed.
- Make illegal states unrepresentable. Distinct primitives get distinct types.
- Immutable default. No parameter mutation without explicit purpose.
- Exhaustive variant handling.
- No untyped escape, ignored diagnostics, non-null assertion, unchecked cast, panic/unwrap in library path.
- Typed errors. Catch only expected errors; unknown errors propagate to boundary.
- Existing project stack and logger win.
- No helper for one caller. No speculative abstraction.

## Test

Public behavior red first. Confirm intended failure. Minimum green. Refactor. Use real object or fake before mock. Deterministic fixture; no sleep. At least one end-to-end user outcome for a new feature. Run smallest test in loop.

## Size

After write, measure pure LOC. Under 200 healthy; 200–250 warn; over 250 split unless generated table or documented indivisible state machine. Function over three independent parameters needs named domain input or specific reason.

## Finish

Run project formatter, linter, strict type checker, targeted tests, then proportional broader gate. Review: one responsibility; typed boundary; exhaustive variants; no escape hatch; no defensive duplicate layer; no one-off helper; regression test exists; no redundant post-action verification; positive names; logging matches project.
