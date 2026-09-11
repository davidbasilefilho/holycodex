# Third-party notices

This file records attribution for dependencies installed by Bun for the
workspace. It is informational; the installed package files and lockfile are
authoritative for platform-specific attribution. Dependency purpose is
summarized in [DEPENDENCIES.md](docs/DEPENDENCIES.md).

## Runtime components

The runtime dependency set includes:

- `effect` — MIT, [source repository](https://github.com/Effect-TS/effect)
- `@toon-format/toon` — MIT, [source repository](https://github.com/toon-format/toon)
- `@opentui/core` — MIT, [source repository](https://github.com/anomalyco/opentui)

The package files for these dependencies carry their respective license text.

## Development components

- `oxfmt` — MIT, [source repository](https://github.com/oxc-project/oxc)
- `oxlint` — MIT, [source repository](https://github.com/oxc-project/oxc)
- `typescript` — Apache-2.0, [source repository](https://github.com/microsoft/TypeScript)
- `@types/bun` / `bun-types` — MIT, [source repository](https://github.com/oven-sh/bun)

These packages support local checks and are not implied to be bundled into the
published plugin payload unless the package manifest says so.

The generated Codex protocol types under `packages/codex/generated/` are
repository artifacts rather than third-party packages. Their provenance is
recorded in [PROVENANCE.md](docs/PROVENANCE.md).

## Vendored plugin skills

HolyCodex's `writing-instructions` directory retains the MIT license from its
historical origin in Matt Pocock's `writing-for-agents`; the original upstream
project has not been renamed. Its current GPT-6 instruction contract is
HolyCodex-authored. Matt Pocock's current skill is used only as a documentation
writing reference, not to design HolyCodex model-facing instructions.
Hardik Pandya's adapted `stop-slop` skill retains its upstream MIT license.
Evidence and reference scope are recorded in [PROVENANCE.md](docs/PROVENANCE.md).

HolyCodex-authored material is licensed under [Apache-2.0](LICENSE).
