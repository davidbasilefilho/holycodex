# Runtime probes

- Node/Bun: exact runtime/version, source maps/warnings; inspect event order, handles, promises, memory, CPU. Separate resolution, transpilation, runtime, child process.
- Python: traceback causes, `faulthandler`, debugger, allocation/profile tools; check interpreter/env, imports, sync blocking in async, resource ownership.
- Rust/native: symbols, backtrace, debugger, sanitizer, Miri, profiler as needed; check UB, ownership, ABI, signal/thread order.
- Go: race detector, pprof, trace, goroutine dump; check cancellation, channel ownership, leaks, copied synchronization.
- Bundled JS: reproduce source and bundle; verify target/runtime/externalization/source map. Inspect generated boundary before minified noise.

Capture minimum hypothesis-separating evidence; remove probes after proof.
