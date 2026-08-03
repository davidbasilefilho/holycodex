# Architecture

`packages/cli` owns parsing, managed configuration, lifecycle, doctor, and prompt composition. `packages/plugin` is the published static payload. `packages/lsp-core` owns language-server protocol behavior; `packages/lsp-daemon` owns reusable daemon transport and the CLI. `packages/git-bash` owns Windows resolution and launch. `packages/runtime-core` owns neutral bounded child-process primitives.

`packages/cli/src/catalog.ts` is authoritative for current routes, limits, historical route recognition, skills, and generated runtime expectations. Routing documentation is contract-tested against it.
