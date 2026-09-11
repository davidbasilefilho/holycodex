# HolyCodex repository guide

## Toolchain

- Bun owns runtime, package management, scripts, tests, builds, generated
  bindings, and npm packing (`bun pm pack`). npm remains the publication
  boundary.
- OXC owns formatting and linting. TypeScript owns strict typechecking.
- Effect and Effect Schema define typed domain, external, CLI, Codex, and
  persisted boundaries; validate values at the receiving edge.
- Keep dependencies on the existing package graph. Do not add Jest, Vitest,
  Zod, another package manager, bundler, or linter for overlapping capability.

## Coding guidelines

- Use JSDoc for all exposed/public/exported functions and APIs

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
- Preserve package ownership and dependency direction. Use JSDoc for exported
  APIs.
- Type-checking is done by `oxlint` and `oxlint-tsgolint` via lint and check package scripts. Do not use `tsc` for type checking.
- Keep the lockfile deterministic. Normal semver dependencies follow the
  current major compatibility line; zerover dependencies stay on their
  current minor line. Exact pins require a concrete technical, security, or
  reproducibility reason beside their source of truth. GitHub Action commit
  SHAs remain content-addressed.
