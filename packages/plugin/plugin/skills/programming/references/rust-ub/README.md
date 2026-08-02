# Rust unsafe / FFI

Minimize unsafe; safe wrapper owns invariant. State aliasing, alignment, initialization, lifetime, provenance, thread, unwind, ownership assumptions at boundary. Validate foreign pointer/length before slice; define allocation/deallocation owner; use `repr(C)` only for ABI. No reference from null/misaligned pointer, mutable alias, unchecked integer-pointer guess, or FFI unwind. Add boundary tests. Run Miri before/after fix; sanitizer/loom when memory/concurrency requires.
