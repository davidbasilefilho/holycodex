# Development

This document owns the repository development process. Package ownership and
dependency direction are in [ARCHITECTURE.md](ARCHITECTURE.md), observable
behavior is in [BEHAVIOR.md](BEHAVIOR.md), and evidence limits are in
[PROVENANCE.md](PROVENANCE.md).

## Toolchain

`mise.toml` selects the pinned Bun line and project tools. Use Bun as the only
local runtime, package manager, script runner, and test runner:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check:fix
mise exec -- bun run test -- --run
```

Vite+ owns formatting, linting, type checking, and test orchestration. The
lockfile and manifests must agree before handoff. Authored TypeScript uses
strict settings and Bun-native APIs where available. Effect Schema from
`effect/Schema` validates every external, persisted, CLI, Codex, and
specialist boundary.

## Package and dependency direction

The graph is `core` to `codex`, `plugin`, and `cli`; `cli` composes the
published surface. Keep the graph acyclic, keep I/O in its owning package, and
put policy in one module. Do not add a dependency to bypass an owner or
boundary. Markdown needs no SPDX header; authored code uses `Apache-2.0`.

## Clean-room contribution boundary

Contributions may use the task specification, expressly admitted current-source
facts, and files authored on this repository for internal consistency checks.
Do not read, search, import, quote, adapt, or compare undocumented historical
implementation material. Material ambiguity returns to Root.

## Checks and test isolation

Run the checks proportional to the changed seam and inspect the final diff:

```sh
mise exec -- vp check --fix
mise exec -- vp test --run
mise exec -- bun run validate
git diff --check
```

Documentation checks validate local links, required owning topics, and the
canonical version sources. Tests that touch installation use temporary,
non-overlapping paths and never inspect a personal `CODEX_HOME`, credentials,
or a broad filesystem path.

The validation gate builds the package, verifies generated plugin assets,
checks dependency attribution and architecture invariants, and exercises the
isolated install/remove path. Checked-in CI runs the gate on its supported
platforms. Release publication is configured through the checked-in GitHub
Actions pipeline and remains approval-gated.
