# HolyCodex

HolyCodex is an independently authored, clean-room foundation for installing
an owned Codex plugin payload and running bounded TypeScript workflows. The
public package is the `holycodex` CLI; the workspace packages keep domain
values, Codex transport, isolated evaluation, durable orchestration, and plugin
assembly behind one-way interfaces.

The native CLI package graph and control/data flow are owned by
[the architecture contract](docs/ARCHITECTURE.md#package-graph). Runtime
behavior, CLI wire rules, security boundaries, and admissible evidence belong
to [BEHAVIOR](docs/BEHAVIOR.md), [CLI](docs/CLI.md),
[SECURITY](docs/SECURITY.md), and [PROVENANCE](docs/PROVENANCE.md).

## Start here

Install the pinned toolchain and workspace dependencies with `mise` and Bun:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun packages/cli/src/index.ts version
```

The command reads the canonical public version from the `holycodex` package at
runtime. Do not copy a release version into documentation or source.

Run the repository checks with Vite+:

```sh
mise exec -- vp check --fix
mise exec -- vp test --run
git diff --check
```

The complete local validation gate is:

```sh
mise exec -- bun run validate
```

This gate includes the package build, artifact/provenance checks, isolated
package smoke, and the fixture fresh-clone proof. Checked-in CI runs the same
gate on Ubuntu and Windows/Git Bash. Publication, deployment, registry access,
and release-tag actions are not configured; see [RELEASING.md](docs/RELEASING.md)
and [CUTOVER.md](docs/CUTOVER.md) for the separate approval boundaries.

## CLI examples

### Official plugin installation

Install HolyCodex through the Codex plugin marketplace. This is the supported
installation method:

```sh
codex plugin marketplace add davidbasilefilho/holycodex
codex plugin add holycodex@holycodex
```

Use the standalone CLI through `bunx` for diagnostics or legacy repair when
the plugin cannot start. `bunx holycodex install` repairs the owned legacy
payload and marketplace state; it is not a replacement for the official
`codex plugin add` installation path.

Use an isolated pair of roots when trying installation locally. The installer
requires a non-overlapping `CODEX_HOME` and personal marketplace root.

```sh
test_root="$(mktemp -d)"
cli='mise exec -- bun packages/cli/src/index.ts'

$cli install --yes --json \
  --codex-home "$test_root/codex" \
  --marketplace-root "$test_root/marketplace"
$cli doctor --json \
  --codex-home "$test_root/codex" \
  --marketplace-root "$test_root/marketplace"
$cli cleanup --scope workspace --yes --json \
  --codex-home "$test_root/codex" \
  --marketplace-root "$test_root/marketplace"
```

An installed executable exposes the same command surface:

```sh
holycodex doctor --json
holycodex cleanup --scope expired --json
holycodex workflow run ./workflow.ts '{}' --trusted --json
holycodex workflow list --json
```

QuickJS TypeScript workflow execution is the production path. The CLI
type-checks and validates a trusted workflow before evaluating it. Capability
calls are denied unless an approved typed port is supplied:

```sh
holycodex workflow run ./workflow.ts '{}' --trusted --json
holycodex workflow run ./workflow.ts '{}' --json
```

`--compat-quickjs` remains a deprecated one-release alias and does not select
a different evaluator. Stdin requires an explicit `--task` objective. CLI-created workflows
are stored under `~/.codex/workflows/{codex-session-id}/{workflow-name}-{4-lowercase-hex}.ts`,
for example `review-api-a3f9.ts`.
`holycodex workflow --help` and `holycodex --help` show the current syntax,
including capability-gated Work, Web, Security, Computer Use, LSP, LSP setup,
and Git Bash providers. A missing provider returns a typed `capability_denied`
result; selecting a provider does not claim availability or install a fallback.

Human output is concise, status-first, and indented for scanning, in the style
of the official Bun CLI. `--json` remains the stable machine contract: one
bounded envelope on stdout, with diagnostics and progress on stderr.

Workflow lifecycle commands persist validated state: `run` creates a run,
`inspect` and `show` are read-only projections, `pause`, `restart`, `reopen`,
`stop`, `resume`, `continuation`, `goal`, `save`, `invoke`, and refinements
apply only valid transitions. Resume resupplies source and arguments and
verifies their stored digests. An uncertain effect remains blocked and is not
retried automatically. If a run is stale, inspect it first, then use
`workflow restart <run-id>` only after it is terminal; restart reopens the run
without claiming an uncertain effect. Use
`cleanup --scope workflow-session --session-id <id> --yes` only to remove an
inactive generated-workflow session. The exact command syntax, envelopes, exit codes, and
non-TTY behavior are owned by [CLI.md](docs/CLI.md). Installation identity,
recovery, cleanup, and legacy-state migration are owned by
[INSTALLATION.md](docs/INSTALLATION.md) and [STATE.md](docs/STATE.md).

## Repository map

- [Installation](docs/INSTALLATION.md) — payload identity, activation, doctor,
  cleanup, and isolated roots.
- [State](docs/STATE.md) — schema epochs, identities, journals, checkpoints,
  replay, continuation, refinement, and telemetry.
- [Configuration](docs/CONFIGURATION.md) — precedence, plans, optional
  selections, paths, and managed writes.
- [Development](docs/DEVELOPMENT.md) — the Bun, mise, Vite+, TypeScript, and
  Effect Schema workflow.
- [Releasing](docs/RELEASING.md) — versioning, local/CI proof, and approval
  boundaries.
- [Cutover](docs/CUTOVER.md) — the recoverable, separately gated repository
  rename and archival runbook.
- [Dependencies](docs/DEPENDENCIES.md) — dependency rationale and source
  links.
- [Third-party notices](THIRD-PARTY-NOTICES.md) — installed runtime and
  development attribution records.

## Clean-room provenance and security

This repository is authored under the clean-room boundary recorded in
[PROVENANCE.md](docs/PROVENANCE.md). It uses only the task specification,
expressly admitted official current-source facts, and files authored on this
repository for internal consistency. Do not import undocumented historical
behavior or legacy implementation material.

Report security concerns through the process in
[SECURITY.md](docs/SECURITY.md). The repository's license and informational
notices are [LICENSE](LICENSE), [NOTICE](NOTICE), and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Current limitations

The default CLI workflow adapter has no configured specialist executor, so a
workflow that requests a specialist operation fails closed until an approved
executor is supplied. Official plugin selection depends on a capable Codex
executable. `multi_agent_v2` is locally disabled and its distinct generated
lifecycle is unverified; advertised V2 therefore fails closed and the stable
App Server fallback remains executable. The installer has an explicit,
idempotent legacy-state migration with quarantine and recovery; unknown schema
epochs still fail closed. npm publication is manual, approval-gated, and
version-checked through `.github/workflows/publish.yml`; GitHub release
publication and deployment remain excluded.
