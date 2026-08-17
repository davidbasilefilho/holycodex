# HolyCodex

HolyCodex is an independently authored, clean-room foundation for installing
an owned Codex plugin payload and running bounded TypeScript workflows. The
public package is the `holycodex` CLI; the workspace packages keep domain
values, Codex transport, isolated evaluation, durable orchestration, and plugin
assembly behind one-way interfaces.

The package graph and control/data flow are owned by
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

Local builds and packs are intentionally not part of the development loop;
the CI release gate owns those validations. See
[DEVELOPMENT.md](docs/DEVELOPMENT.md) and [RELEASING.md](docs/RELEASING.md).

## CLI examples

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

Workflow files must be TypeScript and project files must pass the trust gate.
The exact command syntax, envelopes, exit codes, and non-TTY behavior are
owned by [CLI.md](docs/CLI.md). Installation identity, recovery, and cleanup
are owned by [INSTALLATION.md](docs/INSTALLATION.md).

## Repository map

- [Installation](docs/INSTALLATION.md) — payload identity, activation, doctor,
  cleanup, and isolated roots.
- [State](docs/STATE.md) — schema epochs, identities, journals, checkpoints,
  replay, continuation, refinement, and telemetry.
- [Configuration](docs/CONFIGURATION.md) — precedence, plans, optional
  selections, paths, and managed writes.
- [Development](docs/DEVELOPMENT.md) — the Bun, mise, Vite+, TypeScript, and
  ArkType workflow.
- [Releasing](docs/RELEASING.md) — versioning, CI-only release gates, and
  approval boundaries.
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
executable. There is no automatic state migration engine, and build, pack,
install, doctor, and clean-checkout release validation is CI-owned rather than
a local release shortcut.
