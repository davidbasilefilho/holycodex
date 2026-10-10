# Codex 0.162.1 compatibility

HolyCodex 0.17.0 now targets OpenAI Codex `rust-v0.162.1`, full commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. The commit in `upstream.toml`
is the materialization authority; a mutable release or tag is not sufficient.
The native workspace still uses upstream Rust 1.95.0.

## Ported contracts

- Preserve upstream agent mailbox delivery/watch APIs alongside HolyCodex
  specialist reallocation. Retain the new turn-extension initializer when
  updating session settings.
- Send model instructions through upstream's developer-message input format.
  Select HolyCodex Root/specialist instructions by session source; internal
  maintenance sessions retain their own instructions. Use upstream's current
  Responses Lite tool encoding and omit empty tool prefixes.
- Refresh HolyCodex Root authority only inside the new upstream configuration
  publication path, after its captured-owner and managed-policy checks. Keep
  stale/rejected refresh handling and enterprise MCP revocation intact.
- Preserve upstream application-network-policy invalidation when auth ownership
  changes and propagate credential-storage telemetry into blocking persistence.
  The compatibility update does not relax credential validation or routing.
- Retain upstream daemon managed-config precedence and elevated-Windows launch
  behavior, together with HolyCodex runtime-identity checks and foreground
  fallback for a missing complete package or foreign daemon.
- Startup UI permissions remain unknown until server initialization. Refresh
  the visible runtime provenance and snapshots without treating local startup
  configuration as verified execution authority.
- Adapt to the current `ShellInvocation`, model metadata, and feature-resolution
  APIs. The workspace lockfile includes upstream's current dependency graph and
  the canonical HolyCodex crate dependencies.

## Validation boundary

The patch must strictly apply to a pristine checkout at the full upstream
commit, then materialize the canonical owned sources. Root workspace tests,
Clippy, formatting, TOON feature variants, runtime-identity fixture tests, and
native Cargo checks are separate gates from executing native integration tests.
Fixture executables are not evidence that a real distribution runs.

Compatibility pull requests touching the pin or patch series run the existing
read-only native artifact-validation workflow. Every checkout and artifact
proof uses the same immutable GitHub candidate SHA. The called workflow builds
and tests Linux, Windows, and macOS, stages both native aliases, installs the
actual packed distribution, and verifies the complete artifact set. It does
not invoke the publication workflow or grant write/identity-token permissions.
The existing Linux sandbox setup changes namespace controls only on its
throwaway GitHub runner; approval for such an action remains separate from
ordinary source publication.

A source update is not release readiness. Require the native matrix, artifact
identity gates, complete third-party notice inventory, independent review, and
separate publication authorization before distributing the release.
