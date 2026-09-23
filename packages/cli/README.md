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

Profiles select configured Root and specialist route identities and the
per-task effort matrix documented in [BEHAVIOR.md](../../docs/BEHAVIOR.md).
Every generated instruction targets GPT-6-family behavior regardless of a
temporary routing model ID. Historical values are migration-only.
Root uses `gpt-6-sol` for low/default and `gpt-6-astra` for high; native specialist route files use `gpt-6-luna`. Routing identity remains separate from
instruction behavior.

Frontend and Security are selected by default; Computer Use is
opt-in. Selected capabilities must install and verify or installation fails.
The interactive installer accepts additional plugin IDs separated by whitespace;
the repeatable `--add-plugin <id>` option remains available for scripts.
Reinstalling with the current package reconciles a previous installation.
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
