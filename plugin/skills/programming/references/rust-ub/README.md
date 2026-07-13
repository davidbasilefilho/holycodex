# Rust unsafe / FFI

Minimize unsafe surface; safe wrapper owns invariant. State aliasing, alignment, initialization, lifetime, provenance, thread, unwind, and ownership assumptions beside boundary. Validate foreign pointer/length before slice; define allocator and deallocation owner; use `repr(C)` only where ABI requires. No reference from possibly null/misaligned pointer, mutable alias, unchecked integer-to-pointer guess, or unwind across FFI. Add boundary tests. Run Miri first and after fix; use sanitizer/loom when memory or concurrency model requires it.
