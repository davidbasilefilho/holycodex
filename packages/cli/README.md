# HolyCodex CLI

## What?

The published `holycodex` package installs and removes HolyCodex through
Codex's native plugin management. It also records the selected route plan,
service tier, and optional capability selections in the owned configuration.

## Why?

Native Codex plugin management owns installed assets and native subagent
execution. The CLI is a small, typed configuration boundary around that
platform surface.

## How?

```sh
bunx holycodex install
bunx holycodex remove
```

`--plan` selects routing only. `--tier` is independent and controls service
handling without changing routes or authority. Optional selections are
`--work`, `--frontend`, `--security`, and `--computer-use`; unavailable
selections fail closed. `--json` emits one machine-readable result.

The development entry point is:

```sh
mise exec -- bun packages/cli/src/index.ts install --yes
```

Command syntax and response contracts are owned by [CLI.md](../../docs/CLI.md).

## Contribute

Use Bun through `mise`, keep changes within the assigned package seam, and run
the relevant validation before handoff.

## License

HolyCodex is licensed under [Apache-2.0](../../LICENSE).
