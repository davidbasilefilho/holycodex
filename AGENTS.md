# HolyCodex agent contract

## Stack

- Bun owns runtime, package management, scripts, tests (`bun test`), builds,
  bundles, and packing where applicable. `bun pm pack` is the npm tarball
  operation; npm remains the trusted npm publication boundary.
- OXC owns formatting and linting; TypeScript owns typechecking. TypeScript
  remains strict.
- Effect and Effect Schema own typed domain, external, CLI, Codex, and
  persisted boundaries. Validate at the receiving edge.
- Respect package ownership and dependency direction. Use existing packages
  before adding alternatives; do not introduce Jest, Vitest, Zod, another
  package manager, bundler, or linter to duplicate existing capability.

## Dependencies

Normal semver dependencies use the current major compatibility line. Zerover
dependencies use the current minor line (`0.5.x` stays within `0.5`). Apply
that policy to project tooling and CI CLIs, including npm. Keep the lockfile
as deterministic resolved state and refresh compatible dependencies rather
than freezing manifests indefinitely. Exact pins are exceptional: document a
concrete technical, security, or reproducibility reason beside their source
of truth. Content-addressed GitHub Action commit SHAs remain pinned.

## Authority and orchestration

Root owns user intent and acceptance, material architecture/product/policy
decisions, lifecycle, approvals, integration acceptance, external effects,
and final completion. Root MUST orchestrate and delegate every task, including
trivial work, through a bounded Assignment and native Codex specialist. The
only direct Root execution exceptions are Git/VCS and Computer Use when
`--computer-use` was selected at install. Root does not implement, test,
review, research, or operate CI locally. Specialists return compact
`completed`, `blocked`, `needs_root_input`, or `failed` outcomes with evidence;
Root persists them through `holycodex-agent` and resolves material choices.

After integration, Root performs the VCS action, delegates exact-ref/SHA
terminal CI or release observation, delegates fixes for failures, and repeats
until the repository's discovered gate is green. Pending is never success.
When release is in the requested and approved scope, Root releases only after
the development gate is terminal green, then delegates terminal release
observation and repeats bounded repair until that gate is green. If there is no
separate release gate, record the discovered single-gate topology rather than
inventing one.
Never assume a branch/provider topology. Git/VCS and approval policy remain
Root-only; leaves cannot delegate, message peers, or mutate global Intent
lifecycle.

Root uses `request_user_input` before seeking plan approval, before any
installation profile or plan approval, before any remote/origin/server VCS
mutation or public publication/release, and whenever ambiguity or missing
material input blocks safe progress. Before asking, finish authorized
read-only, reversible, preparatory, and independent work that can reduce
uncertainty; persist the corresponding `needs_root_input` outcome on the
Intent or Plan. Dispatch independent non-overlapping Assignments concurrently
when useful, while preserving dependencies and serializing writes to one
mutable seam. A mandatory Reviewer.code fixed-point review must pass after
implementation or a major codebase change and before completion or any VCS
operation. A review fixed point means no actionable finding remains in scope;
do not repeat broader testing without a new change, failure, or evidence gap.

## State and command surfaces

Installation/configuration state belongs under Codex home and is distinct from
repo-local ignored `.holycodex/` Intent/Plan/Assignment work state. The public
`holycodex` CLI is human-facing installation/doctor/remove/version only; the
deterministic, non-interactive `holycodex-agent` CLI is the model-facing
semantic state API. Use its Intent, Plan, and Assignment operations; do not
manually edit TOON or create handoff/Decision/blocker files. Handoff is only a
redacted projection of current Intent state.

## Change hygiene

Use JSDoc for exposed/exported functions and APIs. Preserve secure native
Codex agent boundaries, trusted publication, and unrelated user state. Run
the smallest relevant Bun proof first, then the project validation gate; fix
pre-commit and CI issues that arise. Inspect the final diff and remove
incidental generated output.

All Root and write-capable agent mutations follow one surgical-mutation rule:
minimize the edit/write surface and operation count while remaining careful,
complete, and evidence-driven. Keep this rule stable across generated
instructions and skills instead of inventing narrower variants.
