# Development

This document owns the repository development process. Package ownership and
dependency direction are in [ARCHITECTURE.md](ARCHITECTURE.md), observable
behavior is in [BEHAVIOR.md](BEHAVIOR.md), and evidence limits are in
[PROVENANCE.md](PROVENANCE.md).

## Toolchain

`mise.toml` selects the Bun compatibility line. Use Bun as
the local runtime, package manager, script runner, native test runner, build
tool, and pack tool:

```sh
mise install
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun pm pack
```

OXC owns formatting, linting, and the repository's type-aware checks through
`oxlint` and `oxlint-tsgolint`. Bun owns test execution, packaging, and builds.
The lockfile and manifests must agree before handoff. Authored TypeScript uses
strict settings and Bun-native APIs where available. Effect Schema from
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

Use meaningful proof appropriate to the changed behavior plus the repository
checks below. A low-impact reversible change does not need a test that merely
mirrors its implementation. Once relevant proof passes, broaden or repeat only
after another source change, a proof failure, or an unresolved material concern.
This rule does not weaken mandatory repository gates or `Reviewer.code`.

Run the checks proportional to the changed seam and inspect the final diff:

```sh
bun run check
bun test
bun run fmt:check
bun run lint
bun run validate
git diff --check
```

Follow the authority and acceptance policy in [BEHAVIOR.md](BEHAVIOR.md).
Root owns judgment, lifecycle, the shared dev server, visual inspection, and VCS
writes; specialists own execution and read-only VCS/CI observation. Explicit
user instructions may request direct execution. Reuse current evidence and
parallelize independent work; only actual dependencies and conflicting writes
require ordering. There is no automatic planning or Plan approval workflow.

Apply the canonical core surgical-mutation rule to source-mutating specialist
tasks:
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
