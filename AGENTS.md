# HolyCodex repository guide

Read HOLYCODEX_BIBLE.md.

## Toolchain

- Bun owns runtime, package management, scripts, tests, builds, generated
  bindings, and npm packing (`bun pm pack`). npm remains the publication
  boundary.
- OXC owns formatting and linting. TypeScript owns strict typechecking.
- Effect and Effect Schema define typed domain, external, CLI, Codex, and
  persisted boundaries; validate values at the receiving edge.
- Use Effect for project-logic composition and error handling; do not add handwritten
  Promise orchestration, try/catch, or manual boundary validation. Use Effect.Schema
  for validation. Keep `Effect.runPromise` and third-party Promise APIs at integration
  boundaries.
- Keep dependencies on the existing package graph. Do not add Jest, Vitest,
  Zod, another package manager, bundler, or linter for overlapping capability.

## Coding guidelines

- Exposed, public, or exported API surface requires useful JSDoc. Inspect the
  existing enforcement first and extend only its gaps.
- Skill descriptions use `situation -> what it does`, with the situation first.
- Keep role guidance canonical and reusable: define task-specific instructions
  first, then append shared role-family guidance once. When changing role
  inventory, update and test routing, projections, install/reconcile/removal,
  and documentation together.

## Repository authority

- `AGENTS.md` and `HOLYCODEX_BIBLE.md` may be modified only when modification
  of that file is included in the user's original instruction or the user
  later explicitly allows it. Do not infer authorization from broader
  repository work.

## Repository architecture

- `packages/core` owns typed profiles, routes, envelopes, errors, and persisted
  work-state contracts.
- `packages/cli` owns the human-facing installer, maintenance flows, native
  Codex projections, and terminal UI.
- `packages/agent` owns the deterministic `holycodex-agent` semantic state
  interface used by model-facing workflows.
- `packages/plugin` owns the checked-in plugin manifest and skill assets.
- `packages/codex` owns generated Codex bindings. Run the generator when its
  source schema or wire fixtures change; do not hand-edit generated output.

## Repository checks and editing

- The repository checks are `bun test`, `bun run check`, and `bun run validate`.
- Preserve package ownership and dependency direction.
- Type-checking is done by `oxlint` and `oxlint-tsgolint` via lint and check package scripts. Do not use `tsc` for type checking.
- Keep the lockfile deterministic and dependencies at current latest stable
  releases. Normal versioned dependencies use caret ranges anchored at the
  latest appropriate release, including `^0.x.y` and `^0.0.x` where required
  by package versioning. Exact pins or other ranges require a concrete
  technical, security, or reproducibility reason beside their source of truth.
  Keep `@openai/codex` as a development dependency on the `latest` dist-tag;
  do not pin its resolved release. GitHub Action commit SHAs remain
  content-addressed.
- Installation/configuration changes must pass the isolated `CODEX_HOME`
  installation test in `packages/cli/src/permission-installation.test.ts`.
  That test must validate installed configuration, profiles, and route
  registrations without creating Codex sessions or making model requests that
  consume usage; config-only diagnostics are allowed.
