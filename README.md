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

The complete local validation gate is:

```sh
mise exec -- bun run validate
```

This gate includes the package build, artifact/provenance checks, isolated
package smoke, and the fixture fresh-clone proof. Checked-in CI runs the same
gate on Ubuntu and Windows/Git Bash. Release behavior and publication gates are
owned by [RELEASING.md](docs/RELEASING.md).

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

Native workflow authors use the supported package entry point rather than a
private workspace package:

```ts
import { workflow, createCodec } from "holycodex/workflow";
```

A trusted native TypeScript file must export a default `workflow.wait(...)`
value and project files must pass the trust gate. Root-authored session
workflows are materialized as ordinary inspectable TypeScript files under
`~/.codex/holycodex/workflows/{sessionId}/{name}-{shortHash}.ts`; their stored
identity/digest is verified before reuse or continuation. Explicit
`workflow save` user/project storage remains a separate feature.

The compatibility evaluator is explicit:

```sh
holycodex workflow run ./workflow.ts '{}' --trusted --json
holycodex workflow run ./workflow.ts '{}' --compat-quickjs --task 'compatibility check' --json
printf 'return { ok: true };\n' | holycodex workflow run - --compat-quickjs --task 'stdin check' --json
```

`--compat-quickjs` is never inferred; native files use the production Effect
workflow runtime, while compatibility mode uses the isolated QuickJS/string
evaluator. Stdin requires compatibility mode and an explicit `--task`
objective. `holycodex workflow --help` and `holycodex --help` show the current
syntax, including the capability-gated Work, Web, Security, Computer Use, LSP,
LSP setup, and Git Bash providers. A missing provider returns a typed
`capability_denied` result; selecting a provider does not claim that it is
available or install a fallback.

The default native CLI path configures Codex `AgentExecution` when the selected
workflow command requires it and fails closed if the required Codex executable
or provider capability is unavailable.

Workflow lifecycle commands persist validated state: `run` creates a run,
`inspect` and `show` are read-only projections, `pause`, `restart`, `reopen`,
`stop`, `resume`, `continuation`, `goal`, `save`, `invoke`, and refinements
apply only valid transitions. Resume/replay verifies the stored workflow
identity and digest and does not silently accept mutated workflow files. An
uncertain effect remains blocked and is not retried automatically. The exact
command syntax, envelopes, exit codes, and non-TTY behavior are owned by
[CLI.md](docs/CLI.md). Installation identity, recovery, cleanup, session
workflow lifecycle, and legacy-state migration are owned by
[INSTALLATION.md](docs/INSTALLATION.md) and [STATE.md](docs/STATE.md).

## Repository map

- [Installation](docs/INSTALLATION.md) — payload identity, activation, doctor,
  cleanup, and isolated roots.
- [State](docs/STATE.md) — schema epochs, workflow-file identity, journals,
  checkpoints, replay, continuation, refinement, and telemetry.
- [Configuration](docs/CONFIGURATION.md) — precedence, plans, optional
  selections, paths, and managed writes.
- [Development](docs/DEVELOPMENT.md) — the Bun, mise, Vite+, TypeScript, and
  Effect Schema workflow.
- [Releasing](docs/RELEASING.md) — versioning, local/CI proof, and publication
  boundaries.
- [Cutover](docs/CUTOVER.md) — the historical/recovery record for the completed
  repository rename and archival sequence.
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

Official plugin selection and native agent execution depend on a capable Codex
executable. `multi_agent_v2` is locally disabled and its distinct generated
lifecycle is unverified; advertised V2 therefore fails closed and the stable
App Server fallback remains executable. The installer has an explicit,
idempotent legacy-state migration with quarantine and recovery; unknown schema
epochs still fail closed. Release publication remains gated by the repository
validation and publishing workflow described in [RELEASING.md](docs/RELEASING.md).
