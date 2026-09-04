# Dependencies

This document owns direct dependency purpose and package placement. Resolved
versions come from the manifests and `bun.lock`; attribution is collected in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## Runtime dependencies

| Package             | Used by            | Purpose                                               | License | Source                                                   |
| ------------------- | ------------------ | ----------------------------------------------------- | ------- | -------------------------------------------------------- |
| `effect`            | workspace packages | Effect Schema validation and typed service boundaries | MIT     | [Effect repository](https://github.com/Effect-TS/effect) |
| `@toon-format/toon` | `core`             | Compact canonical model-wire encoding                 | MIT     | [TOON repository](https://github.com/toon-format/toon)   |

Effect Schema from `effect/Schema` is the sole boundary-validation ecosystem.
Every external, persisted, CLI, Codex, and specialist value is validated at
the receiving edge. Do not add an alternate validator or a dependency that
bypasses an owning package.

## Development dependencies

| Package                    | Purpose                                                 | License    | Source                                                            |
| -------------------------- | ------------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| `vite-plus`                | Formatting, lint, type checking, and test orchestration | MIT        | [Vite-Plus repository](https://github.com/voidzero-dev/vite-plus) |
| `typescript`               | Strict TypeScript checks and build tooling              | Apache-2.0 | [TypeScript repository](https://github.com/microsoft/TypeScript)  |
| `@types/bun` / `bun-types` | Bun declarations                                        | MIT        | [Bun repository](https://github.com/oven-sh/bun)                  |

The workspace packages are authored under the repository Apache-2.0 license
and are not third-party dependencies. Update this rationale with any approved
manifest change.

## Generated Codex protocol artifact

The generated files under `packages/codex/generated/` are protocol types, not
package dependencies. They are regenerated from the stable Codex CLI resolved
by `mise.toml` before validation and packaging, and their executable identity,
inventory, and digest are verified by the generated artifact proof.
