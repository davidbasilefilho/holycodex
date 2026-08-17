# Dependencies

This document records why direct dependencies exist and where their installed
metadata identifies their source and license. Resolved versions come from
`bun.lock`; the tables do not create a second version authority for HolyCodex.
Attributions and installed license text are collected in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## Runtime dependencies

| Package                                   | Used by                                                     | Rationale                                                                                                         | License                          | Source                                                                          |
| ----------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `arktype`                                 | `core`, `codex`, `workflow-host`, `workflow-runtime`, `cli` | Validates boundary envelopes, persisted records, manifests, and workflow protocol inputs.                         | MIT                              | [ArkType repository](https://github.com/arktypeio/arktype)                      |
| `@ark/schema`                             | ArkType runtime                                             | ArkType's schema engine.                                                                                          | MIT                              | [ArkType repository](https://github.com/arktypeio/arktype)                      |
| `@ark/util`                               | ArkType runtime                                             | ArkType's shared runtime utilities.                                                                               | MIT                              | [ArkType repository](https://github.com/arktypeio/arktype)                      |
| `arkregex`                                | ArkType runtime                                             | Typed regular-expression support used by ArkType.                                                                 | MIT                              | [ArkType repository](https://github.com/arktypeio/arktype)                      |
| `quickjs-emscripten`                      | `workflow-runtime`                                          | Runs the isolated workflow child with a QuickJS/Wasm implementation.                                              | MIT; includes QuickJS MIT notice | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `quickjs-emscripten-core`                 | `quickjs-emscripten`                                        | Core runtime bindings.                                                                                            | MIT; includes QuickJS MIT notice | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-ffi-types`                 | QuickJS runtime packages                                    | Shared FFI type declarations and bindings.                                                                        | MIT; includes QuickJS MIT notice | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-wasmfile-debug-asyncify`   | QuickJS runtime                                             | Debug Asyncify Wasm variant.                                                                                      | MIT; includes QuickJS MIT notice | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-wasmfile-debug-sync`       | QuickJS runtime                                             | Debug synchronous Wasm variant.                                                                                   | MIT; includes QuickJS MIT notice | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-wasmfile-release-asyncify` | QuickJS runtime                                             | Release Asyncify Wasm variant.                                                                                    | MIT; includes QuickJS MIT notice | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `@jitl/quickjs-wasmfile-release-sync`     | QuickJS runtime                                             | Release synchronous Wasm variant.                                                                                 | MIT; includes QuickJS MIT notice | [quickjs-emscripten repository](https://github.com/justjake/quickjs-emscripten) |
| `typescript`                              | `workflow-runtime` and development                          | Uses the current TypeScript AST surface for workflow source transformation and provides the TypeScript toolchain. | Apache-2.0                       | [TypeScript repository](https://github.com/microsoft/TypeScript)                |

The `quickjs-emscripten` package brings the four bundled Wasm variants and
their core/FFI packages into the runtime graph. The notices list each package
so a packed artifact can be audited without treating a transitive package as
invisible.

## Development-only dependencies

| Package                    | Rationale                                                               | License                                                                                  | Source                                                            |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `vite-plus`                | Unified check, format, lint, and test orchestration for this workspace. | MIT; its installed CLI notice names additional bundled MIT, ISC, and BlueOak components. | [Vite-Plus repository](https://github.com/voidzero-dev/vite-plus) |
| `@types/bun` / `bun-types` | Bun type declarations for strict TypeScript checks; no runtime import.  | MIT                                                                                      | [Bun repository](https://github.com/oven-sh/bun)                  |

`vite-plus` and Bun type declarations are development-only. TypeScript itself
is not described as development-only here because `workflow-runtime` imports
its AST API at runtime; its Apache-2.0 attribution is therefore included with
the runtime notices.

Workspace packages are authored under this repository's Apache-2.0 license and
are not third-party dependencies. Do not add a dependency merely to bypass an
owner or boundary; update the package graph and this rationale together.
