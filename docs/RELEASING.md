# Release procedure

This document describes the 0.17.0 release flow; a workflow implementation is
not evidence that release gates have passed. Root owns accepting and tagging
the exact release source. A successful `native-release-validation` run for
`v0.17.0` automatically starts `publish-native-packages`; no local command in
this procedure publishes packages or changes Git refs.

## Required release gates

Before creating `v0.17.0`, maintainers must verify all of the following:

1. Root has accepted the final `next` source and advanced `main` to that exact
   commit; the tag, source archive, and all native/npm artifacts must resolve
   to that same full Git SHA.
2. The upstream checkout is exactly the commit in `upstream.toml`, strict
   patches apply, and root `mise` formatting, lint, and tests pass.
3. The actual runtime identity tests prove that both executable names use the
   HolyCodex SIWC client identity (never the official Codex identity) and that
   auth, session, and app-server behavior is equivalent. Host-provided Browser
   Use, Computer Use, and Sites integrations must have their own passing
   compatibility evidence. A CLI build alone is not this evidence.
4. Native integration tests pass on every advertised target. The target list in
   the workflow, optional package metadata, installer selector, and this
   document must agree.
5. Each platform package contains the two names from the single native build;
   byte hashes must match. The wrapper package must install each target in a
   clean npm environment and leave executable bins that do not invoke JS.
6. The complete native dependency and license inventory is reviewed and
   included in the source and binary package notices. The current notices are
   only a partial source attribution until this review is complete.

Any failed or missing check blocks publication. Do not treat build artifacts
or a successful packaging dry run as permission to release. Root should start
the release only after accepting the source SHA and completing these gates.

## Validation workflow

The `native-release-validation` workflow runs on `v0.17.0` and can also be run
manually for validation. It runs the canonical root `mise` quality tasks,
materializes the pinned upstream source, applies the patch layer, builds the
native CLI on supported runners, and uploads one wrapper and three platform
tarballs. Every artifact carries `source-revision.toml` with the checked-out
full Git SHA. The pinned upstream root `justfile` test is run on each native
runner.

Only a successful validation workflow associated with the exact `v0.17.0`
tag triggers `publish-native-packages`. That workflow downloads all four
artifacts from the successful validation run, checks their recorded source
SHA against the run's `head_sha`, inspects package identity, versions, native
aliases and digests, then publishes the three native packages before the
wrapper using npm trusted publishing (OIDC). A failed gate prevents
publication. The npm registry must have trusted publishers configured for all
four package names.

The pinned upstream root `justfile` accepts forwarded test arguments. CI
installs `just` and `cargo-nextest`, then invokes `just test --locked -p
codex-cli` from the upstream repository root. This retains upstream's shell,
8 MiB Rust stack setting, local nextest profile, and failure handling. The
targeted CLI check must be supplemented with the native SIWC, tool/request,
and host integration tests when those patches are complete. It does not
satisfy those release gates by itself.

## npm installation and validation

The Rust tool at `npm/packager` stages native output produced by
`holycodex-dev package`. It rejects empty or different alias payloads and
records their common SHA-256 in `payload.toml`. It also stages the wrapper
and copies the current root license and notices into both distributions.
These staged directories, rather than the source template directories, are
the inputs to `npm pack`.

The packager is a member of the root Cargo workspace and is covered by the
canonical `mise` formatting, Clippy, and test tasks. Staging validates Cargo
and npm versions and optional dependency versions against `upstream.toml`'s
authoritative `holycodex_version` before writing package outputs.

The wrapper includes empty bin placeholders so npm can create its links and
Windows shims. Successful postinstall checks the selected package's name,
version, manifest, and both payload digests before replacing those placeholders
with native bytes. Missing payloads or failed integrity checks fail the
installation. The payload digest detects corruption and alias mismatch;
package authenticity still depends on npm's package integrity and registry
trust.

`npm install --ignore-scripts` cannot complete this installation: it leaves
empty placeholders instead of installing the native payload. Install scripts
and optional dependencies must be enabled. After a successful installation,
the bin targets are native files and the commands require no Node.js runtime.

`npm test --prefix npm/holycodex` checks these installer mechanics with local
tarballs and an independently compiled native fixture in isolated temporary
directories. It verifies native fixture launches and the disabled-script
case without network access or user configuration changes. This is not
HolyCodex runtime evidence. Clean local npm installation and launch tests of
the final HolyCodex binary on every target remain required after native builds,
alongside passing SIWC, tool/request, and host tests before Root releases.

The npm tests include supported-platform checks, corruption and disabled
script failures, plus launches of both installed native fixture files and npm
command links with PATH emptied after installation. The Rust packager tests
cover staging digests, notices, TOML payload metadata, version drift, and
parallel fixture isolation. These are packaging tests, not HolyCodex runtime
evidence.

The published package names are `holycodex` and
`holycodex-native-{linux-x64-gnu,darwin-arm64,win32-x64}`. Registry
availability, account authentication, and trusted-publisher configuration
remain release prerequisites; no scoped namespace is assumed.
