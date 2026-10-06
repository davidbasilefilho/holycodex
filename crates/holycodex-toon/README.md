# `holycodex-toon`

Safe Rust Serde codec for TOON 4.1, adapted from `toon-rs` and verified
against the pinned complete official fixture corpus. The codec source revision,
license, and 4.1 compatibility work are recorded in `NOTICE`; Holy policy
wrappers and the protocol boundary are documented in [`docs/FORMATS.md`](../../docs/FORMATS.md).

The `de_direct` feature and `de::direct::from_str` entry point are retained for
compatibility. They currently use the canonical decoding pipeline, including
strict validation and configured path expansion, rather than a separate fast
path. Enabling a decoding feature must not weaken input validation or change
supported TOON syntax. This favors consistent correctness over the former
experimental fast path's allocation behavior.

The `perf_memchr`, `perf_smallvec`, and `perf_lexical` feature names are also
retained as compatibility switches. They currently use canonical tokenization
and do not enable separate optimization paths. All feature configurations must
preserve the same TOON grammar and pass the pinned conformance corpus.
