# Installation

This document owns HolyCodex payload identity, personal marketplace ownership,
the install transaction, and recovery. Command syntax and response envelopes
remain in [CLI.md](CLI.md); isolation, secrets, and fail-closed recovery remain
in [SECURITY.md](SECURITY.md).

## Owned roots and personal marketplace

The default roots are:

| Root                 | Default                                                     | HolyCodex-owned contents                                            |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Codex home           | `CODEX_HOME`, otherwise `~/.codex`                          | `holycodex/`, `.holycodex-install.lock`                             |
| Personal marketplace | `HOLYCODEX_MARKETPLACE_ROOT`, otherwise `~/.agents/plugins` | `marketplace.json`, `plugins/holycodex/`, and `.holycodex-staging/` |

CLI `--codex-home` and `--marketplace-root` options are explicit overrides for
these roots. Both roots must be absolute, non-broad, traversal-free, real
directories. They must not alias or contain one another, and managed paths may
not pass through symlinks. HolyCodex owns only its state directory, its
payload directory, and its managed marketplace entry; unrelated marketplace
entries remain untouched.

The managed entry identifies owner `holycodex`, category `Development`, install
policy `AVAILABLE`, and auth policy `ON_INSTALL`. Its `source` and cache
identity point to one immutable artifact. A user marketplace document may
contain other plugins, but more than one HolyCodex-owned entry is ambiguous and
fails closed.

## Content-addressed payload identity

Assembly reads the declared source manifest and only its declared skills and
assets. It rejects undeclared files, reserved metadata paths, unsafe paths,
MCP declarations, files over 1 MiB, or a payload over 8 MiB. The generated
plugin metadata and payload metadata are canonical JSON with a trailing
newline.

The payload digest is a domain-separated SHA-256 over the canonical version,
schema epoch, and the sorted file paths and bytes. The identity is the tuple
`{ version, digest, epoch }`. The immutable artifact directory is:

```text
artifact-${digest}-${epoch}
```

The digest covers the exact bytes, not merely a source path. Reusing an
existing artifact is allowed only after re-verifying the same identity; a
directory occupied by a different identity is an identity collision and stops
the install.

## Install transaction

An install is an owned, serialized transaction:

1. Acquire the lock under `CODEX_HOME`, recovering it only when its lease is
   expired and its recorded process is no longer live.
2. Read the prior active record and the canonical public version from the
   `holycodex` package. Resolve plan, tier, and optional selections from the
   request, then the prior record, then safe defaults.
3. Stage the source outside the source tree, assemble the generated metadata,
   and validate every file and digest.
4. Activate the verified staging directory by its immutable content-addressed
   artifact identity.
5. Write the active install record atomically, update only the managed
   marketplace fields, and journal each pointer write.
6. Verify the active record, artifact identity, and marketplace entry as one
   activation. Journal `activation-verified` only after all three agree.
7. Persist the desired official-plugin selection, then apply selected official
   plugins as a managed post-activation effect. Journal success as
   `official-plugins-applied`; a failure or lost response is
   `official-plugins-uncertain`, reported to the caller, and is not falsely
   rolled back.
8. Prune inactive, verified HolyCodex artifacts and journal the result. The
   active artifact is never pruned by this step.

If pointer commitment fails, the previous active record and marketplace bytes
are restored when available. The failure is journaled when possible. An
uncertain pointer or marketplace state is preserved for diagnosis rather than
reported as a successful install.

## The A-to-B invariant

The active record is A and its `relative_path` names artifact B. The marketplace
managed entry is a second pointer to B. The invariant is:

```text
A.artifact_id = B.artifact_id
A.version    = B.metadata.version
A.digest     = B.metadata.identity.digest
A.epoch      = B.metadata.identity.epoch
marketplace(source/cache) = A
```

`verifyActivation` checks the complete identity and canonical managed fields.
Doctor and workspace cleanup rely on this invariant; if it cannot be proved,
they preserve the managed scope and report an integrity reason.

## Doctor, cleanup, and recovery

`doctor` is read-only. It checks the active record, payload identity,
marketplace agreement, and a strict schema-validated installer journal whose
record
identity, event phase, and sequence must be monotonic. It also checks staging
residue, lock shape, Codex MCP configuration, an optional Codex executable
probe, inactive payloads, and optional official-plugin status. A disagreement
with the persisted desired plugin state makes the result unhealthy;
unsupported optional probes are reported as unsupported rather than repaired.

`cleanup` always has an explicit scope:

- `run` targets one safe run identifier under the owned runs root and requires
  `--run-id`.
- `workspace` removes the verified managed marketplace entry, active artifact,
  active record, installer journal, and expired owned residue. It preserves
  foreign, changed, active, or uncertain state.
- `expired` removes residue older than the default 30-day retention (or a
  finite positive override), but only when run state is owned, terminal,
  integrity-valid, resolved, and payloads are verified regular non-symlinks.
  Active, uncertain, corrupt, unresolved, unverifiable, and non-expired state
  is preserved, including the active artifact.

Without `--yes`, cleanup is a preview. JSON mode never prompts; a mutating
non-TTY command must receive `--yes`. Install confirmation and CLI exits are
defined by [CLI.md](CLI.md).

State corruption, a live lock, a symlink boundary, a changed marketplace
entry, or uncertain effect completion stops the relevant operation. Recovery
keeps evidence or quarantines unusable state; it does not turn uncertainty into
success. The durable run-state layout and epoch policy are owned by
[STATE.md](STATE.md).

## Legacy-state migration

Install explicitly recognizes the recorded `legacy-state-1` JSON state shape.
It validates and digests the source, writes and revalidates
`migrated-state.json`, projects compatible installer selections and durable
records, and records each phase in `migration.json`. Identical completed input
is reused, an interrupted migration resumes, and malformed or conflicting
input is quarantined with its historical data retained. `doctor` reports this
state read-only. Unknown schema epochs are not guessed or silently converted;
they fail closed.

## Isolated testing

Use two fresh, explicit roots for local smoke tests so no personal Codex or
marketplace data is in scope:

```sh
test_root="$(mktemp -d)"
cli='mise exec -- bun packages/cli/src/index.ts'
$cli doctor --json \
  --codex-home "$test_root/codex" \
  --marketplace-root "$test_root/marketplace"
```

The same pattern applies to install and cleanup. Remove the temporary parent
after the test is complete; never point a test at a home directory or a broad
filesystem root.
