# Release procedure

The 0.17 layout publishes `holycodex` plus three platform packages under
`@turndev`. It is different from the old 0.16 JavaScript package. Both channels
publish the native packages before the main package, with exact matching
versions and dependency references. A package is not installable until its
native dependency exists in npm.

## Entry point and channels

`.github/workflows/publish.yml` is the only workflow that runs `npm publish`
and creates GitHub releases. It calls reusable `dev.yml` or `stable.yml`, which
call shared native validation in `release.yml`. Validation-only manual runs of
`release.yml` never publish. All downloaded artifacts come from the same run
and must carry the exact source SHA.

A push to `next` triggers DEV. Manual `publish.yml` dispatch is also DEV only
and must select `next`; dispatch availability requires the workflow on the
default branch. A DEV version is `0.17.0-1.dev.<github.run_id>`; retries retain
that version. All four npm packages use dist-tag `dev`, and the GitHub release
is a prerelease with `latest=false`. DEV must preserve every existing `latest`
tag. Runtime version remains the canonical `0.17.0-1`; DEV versioning adjusts
only staged package/dependency/payload metadata, and release notes identify the
source SHA and runtime base. No public version-bump command is introduced.

Stable is implemented separately: an accepted `v0.17.0-1` tag push selects
`stable.yml`, verifies ancestry in `main`, and publishes all four packages
with dist-tag `latest`. Executing stable requires separate Root authorization.
Do not create that tag merely to test the workflows.

The checkpoint stack at implementation time was PR11 -> PR10's branch ->
`next` (PR10) -> `main` (PR9). The publishing PR is stacked on PR11. Root must
integrate the completed stack into `next` to include all runtime/TOON/skill and
publishing changes in DEV. Merging an individual stacked PR into its feature
base does not publish. A push to `next` containing `publish.yml` does; do not
perform that integration before the prerequisites below are ready.

## npm bootstrap and OIDC handoff

Read-only registry checks on 2026-10-08 found `holycodex` with
`latest=0.16.12` and `dev=0.16.12-dev.124.1`. Neither the previous unscoped
native names nor the intended `@turndev/holycodex-native-*` names existed.
Registry 404 is an observation, not evidence that an account can claim a name.
The workflow preflights existence of all four packages and fails before any
publish if one is absent; it does not create placeholders or bootstrap accounts.

An authorized npm owner must first establish the three real scoped packages
using verified native tarballs (public access, DEV tag), confirm scope ownership,
and configure trusted publishing for **each** platform package and `holycodex`:
GitHub owner `davidbasilefilho`, repository `holycodex`, filename `publish.yml`,
with direct `npm publish` allowed. No token, grant, environment or security
setting is created by this repository implementation. Do not publish the main
wrapper while its exact dependencies are absent. Complete this handoff before
coordinating the first DEV run; newly configured publishers expire if their
first successful publish does not occur within two days.

The [npm OIDC documentation](https://docs.npmjs.com/trusted-publishers/) states
that reusable workflow validation uses the caller's workflow identity. GitHub
also distinguishes the caller claims from the callee's `job_workflow_ref` in
[its OIDC documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows).
Here publication executes directly in `publish.yml`; validation callees have
no OIDC permission. The publisher runs on a GitHub-hosted runner with Node 26,
npm 12.2.0 and `id-token: write`. Every package's `repository.url` identifies
this GitHub repository. The current npm service permits up to ten publishers
per package, though this project deliberately uses one entry point.

Publisher preflight checks all archives, identities, versions, aliases and
source revisions. It rejects conflicting already-published integrity before
writing any package. After each publish it reads back the exact version,
integrity and channel tag; platform readback failure withholds the wrapper.
Retries skip byte-identical versions already carrying the expected tag;
an existing version with a different tag requires owner reconciliation rather
than silently changing tags. Partial platform publication can remain after a
failure, but no new wrapper points at missing dependencies. GitHub release
assets are created only after all four registry readbacks succeed. Interrupted
GitHub uploads resume only missing assets; existing tag source, channel, sizes
and SHA-256 digests must match. Conflicting assets are not overwritten.

## Required release gates

Before creating `v0.17.0-1`, maintainers must verify all of the following:

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

`release.yml` is a reusable build/test workflow, also manually runnable for
validation only. `dev.yml` and `stable.yml` pass channel and distribution version
into it. It runs root quality, materializes the exact `upstream.toml` revision,
applies strict patches, and runs the existing native runtime suites on Linux
x64 GNU, macOS ARM64 and Windows x64 before release-profile packaging.
Every tarball artifact includes `source-revision.toml`; native aliases must be
byte-identical. Wrapper dependencies and platform payload metadata are staged
at the same distribution version. The shared verifier checks four distinct
packages and their exact metadata before the publisher runs.

Canonical CI quality passing is not a native build or runtime acceptance result.
Manual/native visual/authentication/host gates and the license inventory remain
separate evidence requirements; DEV labeling does not establish stable readiness.
Root coordinates actual publication and any acceptance limitations.

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
`@turndev/holycodex-native-{linux-x64-gnu,darwin-arm64,win32-x64}`. Registry
availability, account authentication, and trusted-publisher configuration
remain release prerequisites; no scoped namespace is assumed.

## Upgrade policy

HolyCodex must not replace its native policy layer with an upstream Codex
release. Built-in upstream CLI/TUI self-update actions and the daemon's
production installer downloads are disabled. Automatic TUI update discovery does not read
upstream version caches or contact upstream release services.

Install a desired HolyCodex version through its original distribution method.
For a complete local CLI package used by a background server, select it with
`holycodex app-server daemon update --from-cli` and review the confirmation.
This local replacement remains pinned and preserves the package validation
and running-daemon safeguards. The ordinary npm executable-only distribution
is not a complete daemon package. Production daemon updating is disabled, including direct worker startup and
manual requests to existing updater sockets. Managed start/restart/bootstrap
retires an owned updater worker without replacing the daemon package.

A future automatic updater requires a HolyCodex-owned release channel and
separate validation. Do not re-enable the upstream installer as a fallback.
