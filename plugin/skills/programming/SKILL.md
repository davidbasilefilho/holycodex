---
name: programming
description: Use when a task edits Python, Rust, TypeScript, Go, or their matching manifests; do not use for prose-only edits or unsupported languages. Applies language-specific correctness, typing, size, and verification rules; debugging or refactor may additionally own the workflow.
---

# Programming

Before editing `.py`, `.pyi`, `.rs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.go`, or matching manifests, read `references/<language>/README.md`. Load `references/logging.md` only for logs and all `references/rust-ub/` for Rust unsafe or FFI.

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

Defect: add a public-seam regression test first and confirm the intended failure. Explicit test-first request or clearly defined new behavior without adequate proof: test public seam first, confirm failure, implement minimum green, then refactor. Existing tests may lock small covered changes. Do not force red-green for prose, configuration-only work, trivial mechanical edits, or behavior already adequately covered. Use real object or fake before mock. Deterministic fixture; no sleep. Add an end-to-end user outcome for new behavior when proportional. Run smallest test in loop.

## Size

After write, measure pure LOC. Under 200 healthy; 200–250 warn; over 250 split unless generated table or documented indivisible state machine. Function over three independent parameters needs named domain input or specific reason.

## Finish

Run project formatter, linter, strict type checker, targeted tests, then proportional broader gate. Review: one responsibility; typed boundary; exhaustive variants; no escape hatch; no defensive duplicate layer; no one-off helper; regression test exists; no redundant post-action verification; positive names; logging matches project.
