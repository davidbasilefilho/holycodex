# HolyCodex CLI

The `holycodex` package is the public command-line entry point for installing,
inspecting, and removing HolyCodex through Codex's native plugin management.

```sh
bunx holycodex install
bunx holycodex doctor
bunx holycodex remove
```

Use `--yes` when no interactive terminal is available. `--profile` selects
native Root and specialist routing only. `--tier` independently selects
service handling (`standard`, `fast`, or `fast-all`). The live profiles are
`low`, `default`, and `high` (`default` is recommended). Existing serialized
`plan` state migrates to `profile`; legacy `go` state is reported as requiring
an explicit replacement. Legacy `plus-low`, `plus`, and `plus-high`
configuration migrates to `low`, `default`, and `high`; removed Pro profiles
fail with an explicit replacement requirement.

Live routing uses `gpt-6-astra` for Root/session and `gpt-5.6-luna` for every
specialist. The exact per-task effort matrix is documented in
[BEHAVIOR.md](../../docs/BEHAVIOR.md); Sol, Terra, and Go are migration-only
historical values.

Frontend and Security are selected by default; Work and Computer Use are
opt-in. Selected capabilities must install and verify or installation fails.
Use `--json` for one validated machine-readable envelope. Human output reports
the version, profile, tier, selected capabilities, and actionable warnings without
printing the internal installation record.

The development entry point is:

```sh
mise exec -- bun packages/cli/src/index.ts install --yes
```

Command syntax and response contracts are owned by [CLI.md](../../docs/CLI.md).

This package does not expose Intent or Assignment mutation. Root uses the
separate deterministic `holycodex-agent` CLI for repo-local `.holycodex/`
work state; it is non-interactive and has no TUI, prompts, or ANSI output.

## Contribute

Use Bun through `mise`, keep changes within the assigned package seam, and run
the relevant local validation before handoff. Never place environment secrets
or raw environment values in tracked files, package output, logs, CI artifacts,
or uploads.

## License

HolyCodex is licensed under [Apache-2.0](../../LICENSE).
