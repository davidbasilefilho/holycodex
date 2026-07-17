# Runtime probes

- Node/Bun: reproduce with exact runtime/version; enable source maps and warnings; inspect event ordering, handles, promises, memory snapshots, CPU profile. Distinguish module resolution, transpilation, runtime, and external process.
- Python: use traceback with causes, `faulthandler`, debugger, allocation/profile tools. Check interpreter/env, import path, sync blocking in async loop, resource ownership.
- Rust/native: debug symbols; backtrace, debugger, sanitizer, Miri, profiler as symptom requires. Check UB, ownership, ABI, signal/thread ordering.
- Go: race detector, pprof, trace, goroutine dump. Check cancellation, channel ownership, leaked goroutines, copied synchronization.
- Bundled JS binary: reproduce source and bundle separately; verify target/runtime/externalization and source map. Inspect generated boundary, not minified noise first.

Capture smallest evidence that separates hypotheses. Remove probe after proof.
