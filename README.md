# HolyCodex

## What?

HolyCodex is a Codex plugin and CLI for sessions that need dependable
delegation. It installs native specialist profiles, applies a routing plan,
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

Plans choose routing only. `go`, `plus-low`, `plus`, `plus-high`, `pro-5x`,
and `pro-20x` select the native routes; the default is `plus`. Service tiers
(`standard`, `fast`, and `fast-all`) control service handling independently.
They do not change authority or the required proof.

Frontend and Security plugins are selected by default. Work and Computer Use
are opt-in. A selected capability must install and verify successfully or the
installation fails. Use `--json` when another program needs the complete
structured state; human output stays concise.

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
