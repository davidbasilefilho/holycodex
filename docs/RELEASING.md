# Release procedure

This document describes the intended 0.17.0 release flow; it does not assert
that the current implementation has passed its gates. The GitHub workflow
builds validation artifacts only. It does not publish npm packages, create a
GitHub Release, push refs, or create tags.

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
or a successful packaging dry run as permission to release.

## Validation workflow

The `native-release-validation` workflow runs on `v0.17.0` and can be run
manually for validation. It runs the same root `mise` quality tasks, materializes
the pinned upstream source, applies the patch layer, builds the native CLI on
the supported target runners, and uploads validation artifacts keyed by the
workflow source SHA. It intentionally has no publish step. Review the exact
full SHA and all required gates above before any separately authorized release
operation.

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
records their common SHA-256 in `payload.json`. It also stages the wrapper
and copies the current root license and notices into both distributions.
These staged directories, rather than the source template directories, are
the inputs to `npm pack`.

Root's integration must register `npm/packager` in the root Cargo workspace
members and update the root Cargo.lock. Its manifest declares the package
`holycodex-npm-packager` and inherits workspace package metadata and lints.
Once registered, the canonical `mise` formatting, Clippy, test, and pre-commit
tasks cover it through their workspace-wide Cargo commands; this is required
before accepting the staging tool for release.
Staging validates Cargo and npm versions and optional dependency versions
against `upstream.toml`'s authoritative `holycodex_version` before writing
package outputs.

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

The four npm tests consolidate the earlier six cases: supported-platform
checks are grouped, and staging/digest/notice checks moved to the Rust
packager tests. Coverage now also includes corruption failures, disabled
scripts, and launches of both installed native files and npm command links
with PATH emptied after installation, so Node is absent from PATH.

The npm package names currently proposed are `holycodex` and
`holycodex-native-{linux-x64-gnu,darwin-arm64,win32-x64}`. Their registry
ownership and availability have not been verified; a maintainer must resolve
that before publishing. No scoped namespace is assumed.
