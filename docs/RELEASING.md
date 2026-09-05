# Releasing

This document owns release versioning, generated plugin assets, repository
proof, CI validation, provenance, license checks, and approval boundaries.
Product behavior and CLI syntax remain in [BEHAVIOR.md](BEHAVIOR.md) and
[CLI.md](CLI.md). Repository rename and archival remain in the separately
gated [CUTOVER.md](CUTOVER.md) runbook.

## Canonical version and zerover policy

The canonical public version is the `version` field in
`packages/cli/package.json`. The version script validates the target and keeps
that value synchronized with
`packages/plugin/assets/.codex-plugin/plugin.json`:

```sh
mise exec -- bun run version:patch
mise exec -- bun run version:minor
mise exec -- bun run version:set 0.x.y
```

Patch increments the patch component. Minor increments the minor component and
resets the patch component. A dry run reports the change without writing.
Never copy a release literal into source or documentation.

## Generated metadata and lockfile

After a version change, regenerate any generated plugin metadata from its
owning source. Bun regenerates `bun.lock`; do not hand-edit it. A release must
verify that both manifests, generated assets, the lockfile, provenance, and the
public package agree, and that no secret material entered the artifact.

## Local and CI validation

Run the local gate from the exact checkout:

1. Validate manifests, lockfile, generated assets, documentation links,
   version authority, provenance, and third-party notices.
2. Run OXC/TypeScript checks and the full Bun test suite.
3. Build/bundle the package with Bun and verify dependency, license, and
   architecture rules.
4. Pack the public artifact with `bun pm pack` and exercise isolated install
   and removal.
5. Confirm that the artifact contains only allowlisted files and no secrets.

The checked-in GitHub Actions pipeline repeats this proof on its supported
platforms and attaches the exact source SHA and artifact digest to release
metadata.

Before completion, Root delegates `Worker.operations` to observe the terminal
development/release result for the exact ref and SHA. Discover the repository
topology from its own configuration: it may have separate development and
release gates, one pipeline, or no formal separation. Pending or running is
never green. If release is in the requested and approved scope, Root performs
the repository's release action only after terminal development green, then
delegates release verification. Root delegates a fix for any failure and
repeats implementation, review, VCS, and exact-ref observation until terminal
green. With no separate release gate, record the single available gate instead
of inventing a second verification path.

## Development and stable channels

`.github/workflows/publish.yml` publishes both channels. A push to `main`
produces a development package under the `dev` tag. A stable release accepts
only an exact non-prerelease `vX.Y.Z` tag whose tag object resolves to the
checked-out SHA and whose version matches the canonical CLI manifest. It
publishes the validated artifact under the stable tag and creates the matching
GitHub release.

Every publish job verifies the artifact metadata and SHA-256 before an external
write. Existing registry or release records are accepted only when their
version, channel, source SHA, and artifact identity match exactly.

## Approval and branch gates

Commit, push, CI dispatch, and publication are separate externally visible
effects. Root uses `request_user_input` before workflow Plan approval,
installation profile approval, and immediately before each remote/origin/server
VCS mutation or publication; confirm the exact files, version, ref, and SHA,
and record the result. If ambiguity or missing material input blocks progress,
persist `needs_root_input` and ask the user.
Publication fails closed when identity, validation, artifact, or registry
checks disagree. A passing `Reviewer.code` fixed-point review is required
after implementation or a major codebase change and before any VCS operation.

The final validation record links the commit, package artifact, generated
metadata, lockfile, tests, provenance ledger, and
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). These records do not make
legal, security, compatibility, performance, or availability guarantees.
