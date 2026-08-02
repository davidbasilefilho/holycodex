# Rust

Preserve crates. Greenfield: stable edition, rustfmt, denied Clippy warnings, tests. Model states with enums/newtypes; borrow before clone; iterators when clearer. Libraries use typed `thiserror`; apps may add `anyhow` context at boundaries. No `unwrap`/`expect`/panic, ignored `Result`, needless clone, blocking async call, unbounded task. Use cancellation-aware structured tasks. Test public behavior; property-test real invariants only. Unsafe/FFI also loads `../rust-ub/README.md`. Run fmt, check, Clippy, targeted tests; Miri for unsafe.
