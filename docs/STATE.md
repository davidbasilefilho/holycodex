# State

This document owns the two state boundaries and their migration rules.
Observable command behavior remains in [BEHAVIOR.md](BEHAVIOR.md), path and
ownership rules remain in [INSTALLATION.md](INSTALLATION.md), and trust rules
remain in [SECURITY.md](SECURITY.md).

## Repo-local work state

Repo-local work state is separate from HolyCodex installation state and is
ignored by default:

```text
.holycodex/{slug}-{short-id}/
├── intent.toon
├── plan.toon                 # optional current Plan
├── plan.old-001.toon         # immutable archived revisions
└── assignments/{id}.toon
```

`intent.toon` is the canonical compact global Intent. `plan.toon` is optional
and answers how the Intent will be achieved. Each Assignment contains its
bounded scope, owner, status, invocation results, evidence, local blocker,
and remaining risk. Global blockers belong to Intent; no standalone blocker,
Decision, transcript, or handoff files exist. The `holycodex-agent` CLI is the
only normal mutation interface; it validates TOON with Effect Schema, writes
atomically, archives plans before revision, guards lifecycle and revisions,
and provides deterministic current-Intent discovery/resume.

The current lifecycle is `scoping → ready → executing → verifying → reviewing
→ complete`, with explicit `blocked`, `needs_root_input`, and `abandoned`
paths. Completion is predicate-checked and cannot bypass unresolved
Assignments, blockers, proof, review, acceptance, or Root readiness. A handoff
is only a redacted projection of current Intent state.

## Store layout and schema epoch

HolyCodex stores one owned configuration beneath the selected Codex home:

```text
<CODEX_HOME>/
└── holycodex/active.json
```

The record contains the schema epoch, version, digest, selected product
profile, service
tier, optional plugin selections, install identity, managed Root configuration,
canonical leaf artifacts, plugin snapshots, and transaction status. Codex owns
its native plugin files and marketplace state; HolyCodex does not copy or
reinterpret those files.

The managed runtime projection is Root in `config.toml` plus one
`{Role}.{task}` TOML and registration for each of the eleven canonical leaves.
There is no managed Root agent file. Preparing and conflicted records remain
diagnosable until install recovery or an ownership-safe removal resolves them;
they are not reported as active success.

Every persisted installation record is validated at load and write time. The current record
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
managed configuration, canonical leaf state, known unchanged legacy Root
files, and native HolyCodex plugin state. Unrelated Codex state is protected.

A future migration must name its source and destination epochs, migrate the
canonical `{Role}.{task}` identity without reviving role-only registrations,
validate every input and output with Effect Schema, preserve identity and
provenance, and write atomically. There is no implicit downgrade or
best-effort conversion.

The installation record migration from product `plan` to `profile` is separate
from the workflow Plan stored in `plan.toon`. A legacy serialized `plan` field
is copied to `profile` without changing its meaning. `plus-low`, `plus`, and
`plus-high` migrate to `low`, `default`, and `high`; legacy `go` and removed
Pro values are recognized explicitly and require an operator-selected
replacement. No historical value is silently mapped to `low`. HolyCodex also
relinquishes its obsolete ownership record for
`features.context_management.experimental_mode` while preserving the existing
value exactly. This includes unchanged values previously written by HolyCodex;
future installs stop claiming the setting without restoring, removing, or
replacing it.
