# State

This document owns the HolyCodex-managed installation record and migration
boundary. Observable command behavior remains in [BEHAVIOR.md](BEHAVIOR.md),
path and ownership rules remain in [INSTALLATION.md](INSTALLATION.md), and
trust rules remain in [SECURITY.md](SECURITY.md).

## Store layout and schema epoch

HolyCodex stores one owned configuration beneath the selected Codex home:

```text
<CODEX_HOME>/
└── holycodex/active.json
```

The record contains the schema epoch, version, digest, selected plan, service
tier, optional plugin selections, and install identity. Codex owns its native
plugin files and marketplace state; HolyCodex does not copy or reinterpret
those files.

Every persisted record is validated at load and write time. The current record
epoch is `state-0.16`. Unknown epochs, malformed values, invalid digests, and
foreign owners fail closed rather than being treated as a compatible record.

## Identity and writes

The configuration digest is a domain-separated SHA-256 over the canonical
managed fields. Canonical JSON is used before hashing, and secrets never enter
the record. Writes are atomic and compare existing owner, schema, install
identity, and managed values before replacing bytes.

A changed or foreign managed value is preserved and reported for explicit
resolution. An uncertain write is never interpreted as success.

## Removal and migration

`remove` first verifies the owner and install identity, then removes only the
managed configuration and native HolyCodex plugin state. Unrelated Codex state
is protected.

A future migration must name its source and destination epochs, validate every
input and output with Effect Schema, preserve identity and provenance, and
write atomically. There is no implicit downgrade or best-effort conversion.
