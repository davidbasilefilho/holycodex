# Development

This document owns the repository development process. Package ownership and
dependency direction are in [ARCHITECTURE.md](ARCHITECTURE.md), observable
behavior is in [BEHAVIOR.md](BEHAVIOR.md), and evidence limits are in
[PROVENANCE.md](PROVENANCE.md).

## Toolchain

`mise.toml` selects the Bun compatibility line and project tools. Use Bun as
the local runtime, package manager, script runner, native test runner, build
tool, and pack tool:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check
mise exec -- bun test
mise exec -- bun run build
mise exec -- bun pm pack
```

OXC owns formatting and linting; TypeScript owns type checking. Bun owns test
execution, packaging, and builds. The lockfile and manifests must agree before
handoff. Authored TypeScript uses strict settings and Bun-native APIs where
available. Effect Schema from
`effect/Schema` validates every external, persisted, CLI, Codex, and
specialist boundary.

## Package and dependency direction

The graph is `core` to `codex`, `plugin`, and `cli`; `cli` composes the
published surface. Keep the graph acyclic, keep I/O in its owning package, and
put policy in one module. Do not add a dependency to bypass an owner or
boundary. Markdown needs no SPDX header; authored code uses `Apache-2.0`.

## Contribution evidence boundary

Contributions may use the task specification, expressly admitted current-source
facts, and files authored on this repository for internal consistency checks.
Do not read, search, import, quote, adapt, or compare undocumented historical
implementation material. Material ambiguity returns to Root.

## Development before stable

Verify changes through the smallest relevant local path first, then broader
local or development checks. Use development or staging CI before any stable
publication or production-like action. If stable verification fails, reproduce
and repair through local/development checks before trying stable again.

## Checks and test isolation

Run the checks proportional to the changed seam and inspect the final diff:

```sh
mise exec -- bun run check
mise exec -- bun test
mise exec -- bun run fmt:check
mise exec -- bun run lint
mise exec -- bun run typecheck
mise exec -- bun run validate
git diff --check
```

Root MUST delegate every task, including trivial work, through a bounded
Assignment and native specialist. Only Git/VCS is always direct Root work;
Computer Use is direct only when selected at installation. Root delegates
implementation, tests, review, and CI/release observation, then integrates
evidence and performs the VCS step. Discover the repository's actual
development/release topology from its own configuration; pending checks are
not green. A passing `Reviewer.code` fixed-point review is mandatory after
implementation or a major codebase change and before completion or any VCS
operation. Root uses `request_user_input` before workflow Plan approval,
installation profile approval, remote/origin/server VCS mutations, public
publication or release, and whenever ambiguity or missing material input
blocks safe progress; persist the resulting `needs_root_input` state.

Apply the repository surgical-mutation rule to Root and write-capable agents:
minimize the edit/write surface and operation count while remaining careful,
complete, and evidence-driven.

Documentation checks validate local links, required owning topics, and the
canonical version sources. Tests that touch installation use temporary,
non-overlapping paths and never inspect a personal `CODEX_HOME`, credentials,
or a broad filesystem path.

The validation gate builds the package, verifies generated plugin assets,
checks dependency attribution and architecture invariants, and exercises the
isolated install/remove path. Checked-in CI runs the gate on its supported
platforms. Release publication is configured through the checked-in GitHub
Actions pipeline and remains approval-gated.
