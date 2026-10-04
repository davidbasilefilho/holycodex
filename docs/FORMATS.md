# Structured data formats

## Boundary

All structured data authored for, or returned by, a Holy-controlled model
interaction MUST use TOON. This mandate is not relaxed by a model or provider
supporting JSON. Holy-owned, non-model native persistence uses typed TOML.

Provider-required Structured Outputs, function-schema payloads, and external
Codex, Cargo, npm, and API protocol JSON remain JSON because those contracts
require JSON. Convert only the model-data payload at a Holy-controlled
boundary; do not convert or wrap the external protocol envelope as TOON.

## Rust API

`holycodex_policy::formats` provides `encode_toon` and strict bounded
`decode_toon` for typed Serde values, plus `encode_toml` and `decode_toml` for
typed native state. Callers must run domain validation after decoding and
before accepting data at a receiving edge. Typed structs should use
Serde's `deny_unknown_fields` where unknown persisted fields are invalid.
TOON preserves explicit `null` as model data; it is not equivalent to a
missing field. External JSON protocols should continue to use their own JSON
types and adapters.

The bundled safe-Rust codec targets TOON 4.1 (Working Draft) and pins the
official specification and fixture source in
`tests/fixtures/toon/metadata.toml`. `decode_toon` applies a 4 MiB document
limit, strict syntax/shape validation, one diagnostic, and a maximum
indentation-derived depth of 128. Declared array counts never cause
count-proportional reservation. These receiver limits are Holy policy, not
TOON specification limits.

## Conformance

Run `cargo test -p holycodex-toon --test spec_conformance` to execute every
case in the pinned official encode and decode fixture files. The JSON fixture
files are preserved byte-for-byte as the upstream protocol corpus; source,
license, immutable spec revision, and SHA-256 are recorded in
`tests/fixtures/toon/metadata.toml`.
