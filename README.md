# HolyCodex

## What?

HolyCodex is a Codex plugin and CLI for sessions that need dependable
delegation. It installs native specialist profiles, applies a routing profile,
and keeps the selected capabilities and service tier in one owned state.

## Why?

Long coding tasks often need repository lookup, current-fact research,
implementation, and review. HolyCodex lets the user-facing Root session send
bounded work to the right specialist and combine the returned evidence while
Root keeps scope, approvals, integration, and final decisions.

## How?

Install the published package through Codex's native plugin management:

```sh
bunx holycodex install
```

Use `--yes` for a non-interactive install. `doctor` inspects the effective
installation, and removal is:

```sh
bunx holycodex remove
```

Profiles choose routing only. The live profiles are `low`, `default`, and
`high`; `default` is recommended. Service tiers (`standard`, `fast`, and
`fast-all`) control service handling independently. They do not change
authority or required proof. Use `--profile <low|default|high>` for new
installations. Existing serialized `plan` fields are migrated losslessly to
`profile`; legacy `go` is recognized and requires an explicit replacement,
while `plus-low`, `plus`, and `plus-high` migrate to `low`, `default`, and
`high`. Removed `pro-5x` and `pro-20x` values remain migration-only and
require an explicit replacement.

Frontend and Security plugins are selected by default. Work and Computer Use
are opt-in. A selected capability must install and verify successfully or the
installation fails. Use `--json` when another program needs the complete
structured state; human output stays concise.

The public `holycodex` CLI is for installation, diagnosis, removal, and
versioning. Root's model-facing state surface is the separate deterministic
`holycodex-agent` CLI. It reads and mutates repo-local ignored Intent, Plan,
and Assignment state under `.holycodex/` using semantic operations; it has no
TUI, prompts, or ANSI output. Handoff is only a redacted projection of that
state, never a second record.

Root MUST delegate every task, including trivial work, through a bounded
Assignment and native specialist. Root retains intent, acceptance, material
decisions, lifecycle, integration, approvals, and completion. Direct Root
execution is limited to Git/VCS, plus Computer Use when explicitly selected at
install. Post-integration CI and release verification are delegated to the
operations specialist against the exact ref/SHA; pending is not success.

The live root/session route uses `gpt-6-astra` at low, medium, or high
reasoning for the selected profile. All eleven specialists use
`gpt-5.6-luna`; their per-task efforts are defined in
[BEHAVIOR.md](docs/BEHAVIOR.md). Sol, Terra, and Go are retained only in
explicit migration or cleanup handling for old installations.

The native surface has eleven canonical leaves: `Explorer.lookup`,
`Explorer.trace`, `Librarian.lookup`, `Librarian.research`,
`Worker.mechanical`, `Worker.implementation`, `Worker.integration`,
`Worker.operations`, `Reviewer.plan`, `Reviewer.code`, and
`Reviewer.artifact`. Each has one TOML and one `config.toml` registration.
Root is the parent Codex session configured in `config.toml`; HolyCodex never
creates `agents/root.toml`.

For repository development, use the pinned toolchain:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run validate
```

Read the owning contracts for [architecture](docs/ARCHITECTURE.md),
[behavior](docs/BEHAVIOR.md), [CLI](docs/CLI.md),
[installation](docs/INSTALLATION.md), [security](docs/SECURITY.md), and
[release](docs/RELEASING.md) details.

## Contribute

Keep changes on a small mergeable seam and run proportional local checks
before broader development or stable-release checks. Keep environment secrets,
credentials, and raw environment values out of tracked files, commits,
packages, logs, CI artifacts, and uploads. Add local secret-bearing paths to
the repository ignore rules and verify them before staging.

## License

HolyCodex is licensed under [Apache-2.0](LICENSE).
