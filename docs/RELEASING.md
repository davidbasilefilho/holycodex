# Release procedure

The 0.17 layout publishes `holycodex` plus three platform packages under
`@turndev`. It is different from the old 0.16 JavaScript package. Both channels
publish the native packages before the main package, with exact matching
versions and dependency references. A package is not installable until its
native dependency exists in npm.

## Entry point and channels

`.github/workflows/publish.yml` is the only workflow that runs `npm publish`
and creates GitHub releases. It calls reusable `dev.yml` or `stable.yml`, which
call shared native validation in `release.yml`. `native-validation.yml` is the
read-only bootstrap entry: push a fresh `codex/native-validation/**` branch at
the reviewed SHA to build all native artifacts before publication, without a
default-branch registration step. Manual `release.yml` runs also only validate
when that workflow exists on the default branch. See [bootstrap commands](BOOTSTRAP.md).
All downloaded artifacts come from the same run and must carry the exact SHA.

Release branches use `release/v<version>/<semantic-change>`, with zero-major
HolyCodex versions and optional version suffixes preserved exactly. A stack
contains separate PRs: the first targets `main`, and each successor targets
its immediate predecessor. Use semantic names, not numeric ordering labels;
verify actual PR dependencies and never infer native stack registration from
names alone. No redundant aggregate branch or PR is required. See the
[release stack policy](BRANCHES.md).

The currently selected DEV publication ref is
`release/v0.17.0/release-routing`. Ordinary pushes to that branch run the entire DEV build/test/pack
validation but **cannot publish**. Branch consolidation is therefore safe
without authorizing a registry write.

After the owner separately authorizes DEV publication and all gates below are
satisfied, explicitly dispatch **publish.yml**, select `release/v0.17.0/release-routing`, and
set the boolean `publish_dev` input to `true`. Its default is `false`; an
unapproved/default dispatch, another branch, a tag dispatch, or a PR event is
rejected. The publication job independently repeats these event/ref/input
checks and waits for all native artifacts. GitHub must have registered this
workflow on the default branch before the manual entry is available; do not
change refs or tags to work around that prerequisite. Reusable validation
workflows never publish or receive OIDC permission.

A DEV version is `0.17.0-dev.<github.run_id>`; retries retain
that version. Explicit version overrides must match the current run ID exactly.
All four npm packages use dist-tag `dev`, and the GitHub release
is a prerelease with `latest=false`. DEV must preserve every existing `latest`
tag. Runtime version remains the canonical `0.17.0`; DEV versioning adjusts
only staged package/dependency/payload metadata, and release notes identify the
source SHA and runtime base. No public version-bump command is introduced.

DEV is a SemVer prerelease, excluded from ordinary stable ranges such as
`^0.17.0`, `~0.17.0`, `>=0.17.0 <0.18.0`, `0.17.x` and `*`. The legacy
`^0.17.0-1` range explicitly opts into prereleases of that core version and
still accepts `0.17.0-dev.<run_id>`; this change cannot retroactively isolate
consumers using that old range.

Stable is implemented separately: an accepted `v0.17.0` tag push selects
`stable.yml`, verifies ancestry in `main`, and publishes all four packages
with dist-tag `latest`. Immediately before npm publication, the remote
branch/tag is resolved again, including annotated-tag peeling; a missing or
moved accepted ref blocks publication. Stable release recovery also refuses
to recreate a removed tag. Executing stable requires separate Root authorization.
Do not create that tag merely to test the workflows.

The active 0.17 changes retain separate PR layers. The original `next` and
PR9–PR14 heads are preserved in cumulative history. Review findings survive
renaming or PR replacement. See the [preservation inventory](CONSOLIDATION-0.17.md)
for exact heads and intentionally historical branches. Publication requires
the accepted ref to contain every approved successor; a green earlier layer
is not evidence for later changes.

## npm bootstrap and OIDC handoff

Read-only registry checks on 2026-10-08 found `holycodex` with
`latest=0.16.12` and `dev=0.16.12-dev.124.1`. Neither the previous unscoped
native names nor the intended `@turndev/holycodex-native-*` names existed.
Registry 404 is an observation, not evidence that an account can claim a name.
On 2026-10-10 the owner registered the three scoped names with
`0.0.0-bootstrap.1`. Public readback verified the bootstrap marker, tarball
integrities, and metadata/README-only contents. This is package registration,
not a native release or proof of OIDC configuration.
The workflow preflights existence of all four packages and fails before any
publish if one is absent; it does not create placeholders or bootstrap accounts.

An authorized npm owner must first register the three scoped package names,
confirm scope ownership, and configure trusted publishing for **each** platform
package and `holycodex`. Registration may use the explicitly requested
`0.0.0-bootstrap.1` scaffolds requested with the `bootstrap` tag, as described in
`BOOTSTRAP.md`; npm also assigns initial `latest` and rejected its removal.
These contain no runtime and are never release dependencies.
The first full DEV publication replaces that registration-only state with the
same validated version across all four packages. Trusted publishing uses:
GitHub owner `davidbasilefilho`, repository `holycodex`, filename `publish.yml`,
with environment **holycodex-publish** and direct `npm publish` allowed. The
repository administrator must independently protect that environment with
selected branch `release/v0.17.0/release-routing` / tag `v0.17.0` and protect those refs against
unauthorized writer changes. Owner review of accepted source and an explicitly authorized DEV dispatch
permit publication after full validation; environment reviewers/self-review prevention are an
optional additional per-release approval, not an npm requirement. The npm
environment constraint and GitHub protections are
mandatory external gates; YAML alone cannot enforce them. No token, grant, environment or security
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

Before creating `v0.17.0`, maintainers must verify all of the following:

1. Root has accepted the final `release/v0.17.0/release-routing` source and advanced `main` to that exact
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
Only the final distribution build sets `CARGO_PROFILE_RELEASE_DEBUG=0` and
`CARGO_PROFILE_RELEASE_STRIP=symbols`. These Cargo profile overrides remove the
pinned upstream release profile's full debugging information and static symbols
without changing the upstream manifest, optimization level, panic behavior,
runtime version, or dev/test diagnostics. Distributed executables consequently
have less detailed native backtraces; debug builds remain available for diagnosis.
Both native entrypoints remain byte-identical regular files.

After `bun pm pack`, each native runner executes `native-smoke.cjs` against its
actual tarball. It verifies package/target/version metadata, payload digests,
native ELF/Mach-O/PE architecture and both aliases, then launches each extracted
binary with `--version` and `--help` in an isolated home. Each launch has a
30-second timeout and bounded captured output. DEV's npm distribution version
is checked separately from the pinned runtime identity
`holycodex 0.17.0 (Codex upstream 0.160.1)`. The smoke gate logs exact compressed
and per-alias byte counts and the payload digest; it fails before artifact upload
on any mismatch. Its unit fixtures test the gate only, not runtime acceptance.

The same native runner then uses `installation-smoke.cjs` to install that exact
archive together with an unchanged Bun-packed wrapper. It starts with an empty,
offline npm cache and disposable global prefix, checks the installed payloads
against the archive digest, and runs both native files and public command
aliases with an empty `PATH`. npm consumer tests are intentional compatibility
coverage; all publication tarballs are packed with Bun. npm 12's script approval
is limited to the exact local wrapper tarball for that one command, with strict
approval enabled; no user/global script policy is persisted.

The shared release verifier also rejects any npm tarball above 256 MiB or native
alias above 384 MiB. Run `37836254693` measured stripped Linux and Windows
tarballs at 218.6 MB and 229.3 MB, with individual aliases at 283.6 MB and
332.9 MB. The expanded budget accommodates these measured release executables;
the independent compressed limit stays at 256 MiB. Both remain enforced
regression budgets; changes require review. Alias comparison/hashing remains
bounded to 64 KiB chunks. Every tarball artifact includes `source-revision.toml`;
wrapper dependencies and platform payload metadata use the same distribution
version. The shared verifier checks four distinct packages and their exact
metadata before the publisher runs.

The aggregate `artifacts` job depends on the wrapper and the complete native
matrix. Publication cannot start until every build, pack, installation check,
upload, and aggregate verification succeeds. DEV and stable publishing share
a job-level concurrency lock while their builds can run in parallel. npm has
no atomic multi-package transaction: platforms are published and read back
before the wrapper, and retry skips only identical immutable tarballs with the
expected tag. Any conflicting integrity or tag blocks all new writes.

An accepted npm publication can remain absent from public registry reads while
npm processes it. The publisher polls with bounded backoff for up to five
minutes per package. Before each publish call it persists an attempt receipt;
acceptance and exact registry confirmation update that receipt. The workflow
uploads the cumulative journal even on failure. A retained attempted/accepted
receipt never authorizes a duplicate publish just because reads return 404.
DEV receipts preserve the original `latest` baseline across retries as well.

Recover by rerunning the failed publishing job with the same source, version,
artifacts and retained journal. Save the journal before rerunning all jobs or
deleting artifacts: missing history after an executed or ambiguous publication
fails closed and requires owner reconciliation. A rerun that has no publication
journal may begin its first publication only when GitHub's prior-attempt job
records prove that the publishing job or step was skipped. Waiting for registry
processing does not justify changing versions or advancing the wrapper.

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
the inputs to `bun pm pack` (Bun 1.4.3, locked through mise).

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
