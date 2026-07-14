---
name: programming
description: Use when a task edits Python, Rust, TypeScript, Go, or their matching manifests; do not use for prose-only edits or unsupported languages. Applies language-specific correctness, typing, size, and verification rules; debugging or refactor may additionally own the workflow.
---

# Programming

Before editing `.py`, `.pyi`, `.rs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.go`, or matching manifests, read `references/<language>/README.md`. Load `references/logging.md` only for logs; load all `references/rust-ub/` for Rust unsafe/FFI.

## Core

- Prefer, in order: no code, existing helper, standard API, native feature, installed dependency, one line, new code.
- Trace real flow and callers. Fix shared root seam once.
- Parse untrusted input once at boundary. Interior stays typed.
- Make illegal states unrepresentable; give distinct primitives distinct types.
- Default immutable; mutate parameters only with explicit purpose.
- Exhaustive variant handling.
- No untyped escape, ignored diagnostics, non-null assertion, unchecked cast, panic/unwrap in library path.
- Typed errors. Catch only expected errors; unknown errors propagate to boundary.
- Existing project stack and logger win.
- No one-caller helper or speculative abstraction.

## Reuse

- One behavior, one implementation.
- Search before writing; reuse or extend the existing implementation.
- Never copy-paste logic or maintain parallel variants.
- Put shared behavior in the smallest stable function, method, type, or module at its common ownership seam. Callers pass data, not reimplement policy.
- Extract repetition when a second caller or copy exists. Keep one-caller mechanics local unless they form a stable domain abstraction.
- Reusable code needs cohesive names, explicit typed I/O, and public-seam tests. Parameterize real variation; reject caller branches and boolean modes.

## Test

Defect: add a public-seam regression test first and confirm the intended failure. Explicit test-first request or clearly defined new behavior without adequate proof: test public seam, confirm failure, implement minimum green, refactor. Existing tests may lock small covered changes. Do not force red-green for prose, configuration-only work, trivial mechanical edits, or behavior already adequately covered. Prefer real object or fake to mock; use deterministic fixtures, never sleep. Add a proportional end-to-end user outcome for new behavior. Run smallest test in loop.

## Size

After writing, measure pure LOC: under 200 healthy; 200–250 warn; over 250 split unless generated table or documented indivisible state machine. Over three independent parameters requires named domain input or a specific reason.

## Finish

Run project formatter, linter, strict type checker, targeted tests, then proportional broader gate. Review: one responsibility; typed boundary; exhaustive variants; no escape hatch; no defensive duplicate layer; no one-off helper; regression test exists; no redundant post-action verification; positive names; logging matches project.
