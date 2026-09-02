# Third-party notices

This file records attribution for dependencies installed by Bun for the
workspace. It is informational; the installed package files and lockfile are
authoritative for platform-specific attribution. Dependency purpose is
summarized in [DEPENDENCIES.md](docs/DEPENDENCIES.md).

## Runtime components

The runtime dependency set includes:

- `effect` — MIT, [source repository](https://github.com/Effect-TS/effect)
- `@toon-format/toon` — MIT, [source repository](https://github.com/toon-format/toon)

The package files for these dependencies carry their respective license text.

## Development components

- `vite-plus` — MIT, [source repository](https://github.com/voidzero-dev/vite-plus)
- `typescript` — Apache-2.0, [source repository](https://github.com/microsoft/TypeScript)
- `@types/bun` / `bun-types` — MIT, [source repository](https://github.com/oven-sh/bun)

These packages support local checks and are not implied to be bundled into the
published plugin payload unless the package manifest says so.

The generated Codex protocol types under `packages/codex/generated/` are
repository artifacts rather than third-party packages. Their provenance is
recorded in [PROVENANCE.md](docs/PROVENANCE.md).

## Vendored plugin skills

The installed plugin contains adapted MIT-licensed material from Matt Pocock's
`writing-for-agents` skill and Hardik Pandya's `stop-slop` skill. Each skill
directory retains its upstream license and attribution; admitted source
revisions are recorded in [PROVENANCE.md](docs/PROVENANCE.md).

HolyCodex-authored material is licensed under [Apache-2.0](LICENSE).
