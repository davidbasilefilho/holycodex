# Development

This document owns the repository development workflow. Package ownership and
dependency direction are in [ARCHITECTURE.md](ARCHITECTURE.md), and evidence
limits are in [PROVENANCE.md](PROVENANCE.md).

## Toolchain

`mise.toml` pins Bun for this workspace. Use `mise` to select the toolchain and
Bun as the only runtime, package manager, script runner, and test runner:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check:fix
mise exec -- bun run test -- --run
```

Vite+ owns project checks and test orchestration. The direct equivalents are:

```sh
mise exec -- vp check --fix
mise exec -- vp test --run
```

The codebase targets current TypeScript 7 with strict settings. ArkType
validates CLI, App Server, persisted, external, and specialist boundaries;
internal values remain typed. Authored code carries an SPDX `Apache-2.0`
header; Markdown is not headed.

## Package and dependency direction

The intended graph is `core` → `codex`, `workflow-runtime`, `plugin`, and
`workflow-host`; `workflow-host` also consumes `codex` and
`workflow-runtime`; `cli` composes the published surface. The graph is
acyclic, package APIs are explicit, and filesystem imports cannot bypass an
owner. Keep I/O in the packages that own it and put policy in one module.
Do not add npm, pnpm, yarn, ESLint, Prettier, or redundant Vite+ tooling.

## Clean-room contribution boundary

Contributions may use the task specification, the expressly supplied official
current-source dossier, and files authored on this repository for internal
consistency checks. Do not read, search, import, quote, adapt, or compare any
legacy HolyCodex, OmO, or LazyCodex implementation material, history, prompt,
skill, hook, agent, bundle, or source. Undocumented compatibility assumptions
are not evidence; material ambiguity returns to the owning decision-maker.

## Checks and test isolation

Before handing off a change, run the checks proportional to its seam and
inspect the final diff:

```sh
mise exec -- vp check --fix
mise exec -- vp test --run tests/documentation.test.ts tests/version-authority.test.ts
mise exec -- vp test --run
git diff --check
```

Documentation tests validate local links, required owning topics, and the
single canonical release-version literal. Tests that touch installation or
workflow state must use temporary, non-overlapping roots and must not inspect a
personal `CODEX_HOME`, marketplace, credentials, or broad filesystem path.

Do not run local build or pack commands as a release substitute. CI owns
build, pack, clean-checkout install, doctor, and publication validation; the
local proof is checks, tests, diff inspection, and explicit isolated smoke
tests.
