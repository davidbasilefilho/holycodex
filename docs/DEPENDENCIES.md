# Dependencies

This document owns direct dependency purpose and package placement. Resolved
versions come from the manifests and `bun.lock`; attribution is collected in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## Runtime dependencies

| Package             | Used by            | Purpose                                               | License | Source                                                     |
| ------------------- | ------------------ | ----------------------------------------------------- | ------- | ---------------------------------------------------------- |
| `effect`            | workspace packages | Effect Schema validation and typed service boundaries | MIT     | [Effect repository](https://github.com/Effect-TS/effect)   |
| `@toon-format/toon` | `core`             | Compact canonical model-wire encoding                 | MIT     | [TOON repository](https://github.com/toon-format/toon)     |
| `@opentui/core`     | `cli`              | Public interactive installer TTY runtime              | MIT     | [OpenTUI repository](https://github.com/anomalyco/opentui) |

Effect Schema from `effect/Schema` is the sole boundary-validation ecosystem.
Every external, persisted, CLI, Codex, and specialist value is validated at
the receiving edge. Do not add an alternate validator or a dependency that
bypasses an owning package.

## Development dependencies

| Package                    | Purpose                  | License    | Source                                                           |
| -------------------------- | ------------------------ | ---------- | ---------------------------------------------------------------- |
| `oxfmt`                    | Formatting               | MIT        | [OXC repository](https://github.com/oxc-project/oxc)             |
| `oxlint`                   | Linting                  | MIT        | [OXC repository](https://github.com/oxc-project/oxc)             |
| `typescript`               | Strict TypeScript checks | Apache-2.0 | [TypeScript repository](https://github.com/microsoft/TypeScript) |
| `@types/bun` / `bun-types` | Bun declarations         | MIT        | [Bun repository](https://github.com/oven-sh/bun)                 |

The workspace packages are authored under the repository Apache-2.0 license
and are not third-party dependencies. Update this rationale with any approved
manifest change.

Bun owns runtime, package management, scripts, `bun:test`, package builds,
bundles, and `bun pm pack`. OXC owns formatting and linting; TypeScript owns
typechecking. `@opentui/core` is public-CLI-only and must not be added to
`holycodex-agent`; preserve its runtime package resolution in the bundle.

## Freshness policy

Normal semver dependencies declare the current major compatibility line and
allow the latest compatible release in that line. Zerover dependencies use the
current minor line (`0.5.x` remains within `0.5`). Apply the same policy to
project tooling and CI CLIs, including npm. `bun.lock` remains the deterministic
resolved execution state and is regenerated after refresh. Exact pins are
exceptional and require a concrete technical, security, or reproducibility
reason near their source of truth. This does not weaken content-addressed
GitHub Action commit-SHA pins.

## Generated Codex protocol artifact

The generated files under `packages/codex/generated/` are protocol types, not
package dependencies. They are regenerated from the stable Codex CLI resolved
by `mise.toml` before validation and packaging, and their executable identity,
inventory, and digest are verified by the generated artifact proof.
