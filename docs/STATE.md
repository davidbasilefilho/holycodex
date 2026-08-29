# State

This document owns durable workflow state, schema epochs, canonical identities,
replay, retention, and migration boundaries. Observable lifecycle rules remain
in [BEHAVIOR.md](BEHAVIOR.md); persistence and recovery threats remain in
[SECURITY.md](SECURITY.md).

## Store layout and schema epochs

The workflow host uses an explicitly owned absolute store with these
directories:

```text
<state-root>/
├── runs/<run-id>/snapshot.json
│             journal.ndjson
├── claims/<parent-revision-checkpoint-digest>.json
└── quarantine/<record>.json
```

The CLI materializes generated workflow source in
`~/.codex/workflows/{codex-session-id}/{workflow-name}-{4-lowercase-hex}.ts`.
The session directory and generated file are owned, digest-checked, and
removed only by the explicit workflow-session cleanup scope.

Every persisted record carries an epoch validated at the receiving boundary.
The current host epoch catalog is:

| Record                       | Epoch                   |
| ---------------------------- | ----------------------- |
| core identity values         | `state-0.15`            |
| runtime protocol             | `runtime-1.0`           |
| host catalog                 | `host-state-1.0`        |
| run and snapshot             | `host-run-1.0`          |
| journal and retained context | `host-journal-1.0`      |
| checkpoint                   | `host-checkpoint-1.0`   |
| continuation and claims      | `host-continuation-1.0` |
| refinement                   | `host-refinement-1.0`   |
| telemetry                    | `host-telemetry-1.0`    |

Epochs are identity components, not display labels. A record with an unknown
epoch, invalid schema, invalid sequence, or mismatched run identity is not
silently interpreted as a newer or older record.

New run snapshots persist a validated `delegation_mode` in the existing
workflow descriptor. The descriptor field is optional only for compatibility
with stored runs from before delegation modes; those records remain readable,
are treated as legacy unspecified, and are never silently rewritten. Inspection
returns the descriptor, including the persisted mode when present. Derived runs
created without workflow descriptors do not invent one.

## Canonical identities

The run identity includes project and trust identities, workflow source and
argument digests, plan catalog and policy digests, route, service tier, prompt,
tool, security, approval, sandbox, Codex capability, and schema epochs. The
host canonicalizes JSON before hashing and uses domain-separated SHA-256 for
identity inputs. Durable state stores these validated identities and
checkpoints, never raw workflow source, arguments, prompts, credentials, or
transcripts. Resume callers must resupply source and arguments and pass both
canonical digest checks before execution effects.

An operation identity includes its safe operation identifier, semantic
fingerprint, route, role, task, attempt, retry limit, and fan-out. The
domain-separated fingerprint covers definition identity, route/role-task,
semantic assignment content, and protocol while excluding mechanical attempt
and scheduling fields. Replaying an operation requires an exact identity and
exact fingerprint. Resupplied source
or arguments must match the run identity; a mismatch is a failure, not a new
run hidden behind the old run ID.

## Journals and checkpoints

The journal is append-only within a run and uses monotonically increasing
sequences. It records creation, state changes, operation lifecycle and
validated v2 specialist outcomes, checkpoints, continuation claims, and
refinements. New operation events accept only v2 outcomes. Existing
`host-journal-1.0` operation records with the legacy universal shape are read
through an explicit route-checked decoder and returned as canonical v2 values;
the journal epoch remains unchanged because the outcome protocol is
self-versioned. Snapshot writes are atomic and always validate before
persistence.

A checkpoint is a validated projection tied to a run, revision, and journal
sequence. It records bounded objective and constraints, decisions, verified
evidence, phases, active and unresolved work, blockers, verification,
resources, retained summaries, next actions, usage completeness, and
recoverable errors. Resume may use only a valid checkpoint plus a validated
journal tail; an uncertain effect or unresolved checkpoint blocks continuation.
After dispatch, a throw, malformed response, cancellation ambiguity, or lost
response is journaled as `uncertain` and blocks the run; it is never retried
automatically.

For stale sessions, inspect first and restart only a terminal run. Restart
reopens the durable run without retrying an uncertain effect; inactive
generated source is cleaned separately through workflow-session cleanup.

Journal appends are serialized by a bounded, owned cross-process lock. The
store validates the on-disk next sequence while holding that lock, so a
process-local cursor is not a correctness authority.

The file store validates snapshots and each journal line on load. Corrupt
records are marked integrity-uncertain and a bounded quarantine record is
written. Replay projects retained records and never re-enters an effect port.

## Replay and retained context

Replay is projection-only. The host admits it only when the supplied identity
equals the stored run identity and a completed operation has the exact same
semantic fingerprint. The replay result is marked `replayed` and does not
retry the specialist or external operation.

Retained context is reusable only after a completed operation persisted a real
App Server thread and turn, and when its project/trust reference, objective
lineage, route/role-task, authority scope, policy digest, tool profile, security
profile, prompt profile, approval policy, sandbox policy, and Codex capability
digest all match. Resume requires a non-empty delta; otherwise execution starts
a fresh non-ephemeral thread. A retained context can be `available`,
`consumed`, `invalidated`, or `blocked`. A partial match returns
`new-context-required`; it never weakens the identity to make reuse succeed.

## Continuation and refinement

A continuation atomically claims an eligible parent checkpoint and creates a
new run ID tied to the same objective lineage with the parent ID recorded.
The derived run inherits the exact plan, route, service-tier, and policy
identities. The caller resupplies source and arguments; both digests are
verified against the parent before the derived run is created. The claim is
keyed by parent revision and checkpoint digest, so stale, ambiguous, mismatched,
or already-claimed input fails closed before effects or a derived run.

A refinement that changes objective, constraints, or acceptance has a new run
ID and refinement identity, preserves parent and lineage, and verifies
resupplied source and arguments. Its refinement journal and explicit,
reversible enabled/disabled status live on the derived run; refinements are
disabled by default and cannot cross project/trust scope.

## Telemetry retention

Telemetry is a sanitized, allowlisted projection. It may carry run and route
identity, the bounded delegation and session modes, event status, measured
duration/count, complete token counters when supplied, error code, schema
epochs, and the replay flag. Absence means usage was unavailable; zero remains
an observed counter. It does not carry prompts, file contents, transcripts,
environment values, credentials, or raw specialist output. Telemetry sinks are
descriptive; sink failure cannot change scheduling or run outcome.

Durable terminal state is retained until an explicit owned cleanup scope
selects it. Active, integrity-uncertain, uncertain, unresolved, corrupt,
non-expired, symlinked, or unverifiable state is protected. Expired cleanup
defaults to 30 days and accepts only finite positive retention overrides or
test clocks. Cleanup deletes only owned, terminal, integrity-valid, resolved
runs and verified inactive payloads. It never deletes foreign files or turns
quarantine evidence into success. Installation-owned retention is described
in [INSTALLATION.md](INSTALLATION.md).

## Migrations

The CLI has one explicit legacy-state migration for the recorded
`legacy-state-1` input shape. Install validates the source with Effect Schema,
writes a content-digested `migrated-state.json`, projects compatible selections,
saved workflows, runs, continuations, and refinements, verifies the target, and
records a completed migration journal. A repeated identical migration is
reused; an interrupted migration resumes from its journal; malformed or
conflicting input is quarantined and retained. Doctor inspects this migration
state without mutating it. See [INSTALLATION.md](INSTALLATION.md) for the
install transaction.

This explicit migration does not reinterpret unknown schema epochs. Any other
epoch change fails closed until a migration names its source and destination,
validates every input and output with Effect Schema, preserves canonical
identity and provenance, writes atomically, and retains a recovery record. An
uncertain journal tail is never discarded.
