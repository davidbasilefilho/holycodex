# Dependencies

This document owns direct dependency purpose and package placement. Resolved
versions come from the checked-in manifests and `bun.lock`; attribution and
installed license text are collected in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). Effect is the sole runtime
validation and workflow-effect ecosystem. The deprecated `@effect/schema`
package and every alternate validator are not part of the dependency graph.

## Runtime dependencies

| Package                                          | Used by                                | Purpose                                                                                  | Recorded license                                                                                 | Source                                                                          |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `effect` 3.22.1                                  | all workspace packages                 | Effect Schema boundary validation, typed Effect services, scheduling, and error handling | MIT                                                                                              | [Effect repository](https://github.com/Effect-TS/effect)                        |
| `quickjs-emscripten` 0.32.0                      | `workflow-runtime`, `cli`              | Isolated, capability-denied QuickJS TypeScript workflow evaluator                        | MIT; bundled QuickJS notices are recorded in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `quickjs-emscripten-core` 0.32.0                 | transitive QuickJS runtime             | QuickJS runtime bindings                                                                 | MIT; bundled QuickJS notices are recorded in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-ffi-types` 0.32.0                 | transitive QuickJS runtime             | FFI types used by the QuickJS bindings                                                   | MIT; bundled QuickJS notices are recorded in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-wasmfile-debug-asyncify` 0.32.0   | transitive QuickJS runtime             | Debug Asyncify Wasm variant                                                              | MIT; bundled QuickJS notices are recorded in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-wasmfile-debug-sync` 0.32.0       | transitive QuickJS runtime             | Debug synchronous Wasm variant                                                           | MIT; bundled QuickJS notices are recorded in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-wasmfile-release-asyncify` 0.32.0 | transitive QuickJS runtime             | Release Asyncify Wasm variant                                                            | MIT; bundled QuickJS notices are recorded in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-wasmfile-release-sync` 0.32.0     | transitive QuickJS runtime             | Release synchronous Wasm variant                                                         | MIT; bundled QuickJS notices are recorded in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `typescript` 7.0.2                               | `workflow-runtime`, `cli`, development | TypeScript AST transformation and the pinned TypeScript toolchain                        | Apache-2.0                                                                                       | [TypeScript repository](https://github.com/microsoft/TypeScript)                |

All package boundary schemas import `effect/Schema`; Effect modules own typed
services and boundary validation. QuickJS TypeScript is the production
workflow evaluator and exposes no capability unless the host supplies an
approved typed port. `--compat-quickjs` is a deprecated one-release alias for
the same evaluator.

## Development-only dependencies

| Package                          | Purpose                                                          | Recorded license                                                             | Source                                                            |
| -------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `vite-plus` 0.2.9                | Unified formatting, lint, type-check, and test orchestration     | MIT; installed bundled notices remain authoritative for its transitive tools | [Vite-Plus repository](https://github.com/voidzero-dev/vite-plus) |
| `@types/bun` / `bun-types` 1.4.0 | Bun declarations for strict TypeScript checks; no runtime import | MIT                                                                          | [Bun repository](https://github.com/oven-sh/bun)                  |

The workspace packages are authored under the repository Apache-2.0 license
and are not third-party dependencies. Do not add a dependency to bypass an
owner or boundary; update the package graph and this rationale together.

## Generated App Server artifact

The checked-in files under
`packages/codex/generated/codex-cli-0.148.0/` are generated protocol
artifacts, not package dependencies. Their provenance is owned by
[PROVENANCE.md](PROVENANCE.md): the inventory contains 943 files with digest
`24436be19cd8ea368d18154da5d8354b9b6ce1671da1fb49e958a6341d3e7d7d`, generated
from Codex CLI binary digest
`ac2cfed85fb647d61e0150b8548102b330e4799d9d81ad5d354de701edf6b074` under
protocol epoch `codex-app-server-0.148.0`. The generated V2 lifecycle is
unverified; stable App Server fallback is the executable route.
