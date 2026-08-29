# Development

This document owns the repository development workflow. Package ownership and
dependency direction are in [ARCHITECTURE.md](ARCHITECTURE.md), and evidence
limits are in [PROVENANCE.md](PROVENANCE.md).

## Toolchain

`mise.toml` selects the Bun `1.4.x` line; the checked-in toolchain resolves to
Bun 1.4.0, TypeScript 7.0.2, and Vite+ 0.2.9. Use `mise` to select the
toolchain and Bun as the only runtime, package manager, script runner, and test
runner:

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

After an approved manifest dependency or Bun pin change, run
`mise exec -- bun install` to regenerate the lockfile; subsequent clean
checkouts use `bun install --frozen-lockfile`. The checked-in lockfile and
repository proof must agree with the manifests before handoff.

The codebase targets TypeScript 7 with strict settings. Effect and its modules
are the single validation and service boundary: Effect Schema from
`effect/Schema` validates every external, persisted, CLI, App Server, and
specialist value, and internal Effect services remain typed. QuickJS TypeScript
workflows are the production path; capability calls are denied unless an
approved typed port is supplied. `--compat-quickjs` is a deprecated one-release
alias for the same evaluator. Internal values remain typed. Authored
code carries an SPDX `Apache-2.0` header; Markdown is not headed.

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

The validation gate runs formatting, lint, TypeScript, the full test suite,
package build, repository proof, generated-artifact verification, package
smoke, fixture fresh-clone proof, and diff hygiene. Checked-in CI runs that
gate on Ubuntu and Windows/Git Bash. A real canonical fresh clone and
post-push Actions result remain external evidence until cutover. Package
publication, release publication, deployment, and registry actions are not
configured.

On Windows, run every shell command through
`C:/Program Files/Git/bin/bash.exe`; the Git Bash capability is denied when
that executor is unavailable. CLI-created workflow source uses
`~/.codex/workflows/{codex-session-id}/{workflow-name}-{4-lowercase-hex}.ts`.
