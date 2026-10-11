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

## Assignment revisions and acceptance

Dispatch and follow-up payloads must carry the current `intent_revision`. The
controller checks this before preparing a specialist and again atomically when
reserving ownership. Historical records without a revision remain readable as
unknown revision zero; they cannot authorize a new dispatch.

`Succeeded` records execution completion, not Root acceptance. The Root-only
`assignment.accept` tool takes `assignment_id` and an `acceptance` object with
`intent_revision`, a substantive `rationale`, and `criteria_evidence` and
`required_evidence` maps. Each map uses the exact declared labels and identifies
nonempty observed support for each one. Unknown, missing, or blank support,
unsuccessful execution, and stale revisions are rejected without changing state.
The runtime verifies structural coverage; Root remains responsible for judging
functional correctness, architectural fit, and the quality of independent review.
A completion message or passing checks alone must not be described as acceptance.

Dependencies require explicit acceptance at the candidate's current revision.
Existing historical execution records remain readable and unaccepted; the runtime
never backfills acceptance from a terminal status. A requirement change preserves
old evidence but does not carry its acceptance into the new revision. Use a current
bounded validation assignment to reassess evidence that remains applicable.
