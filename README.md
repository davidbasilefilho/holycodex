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
installation, `upgrade` migrates an existing installation in place, and
removal is:

```sh
bunx holycodex remove
bunx holycodex upgrade
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

The current Root route is `gpt-6-astra`, while native specialist route files
use the configured `gpt-5.6-luna` identity with their per-task effort matrix.
Those routing identities are separate from the GPT-6-family behavior required
by live skills and generated instructions.

Frontend and Security plugins are selected by default. Computer Use is opt-in.
A selected capability must install and verify successfully or the
installation fails. Use `--json` when another program needs the complete
structured state; human output stays concise.

HolyCodex manages the scalar `features.context_management = true` in the Root
configuration. Upgrade migrates owned historical
`features.context_management.experimental_mode` state and removal restores the
recorded prior value when it is unchanged.

The public `holycodex` CLI is for installation, diagnosis, removal, and
versioning. Root's model-facing state surface is the separate deterministic
`holycodex-agent` CLI. It reads and mutates repo-local ignored Intent, Plan,
and Assignment state under `.holycodex/` using semantic operations; it has no
TUI, prompts, or ANSI output. Handoff is only a redacted projection of that
state, never a second record.

Root delegates every delegable action through a bounded Assignment and native
specialist before inspection or execution, including trivial and preparatory
work. Root owns user interaction, Intent, material decisions, orchestration,
lifecycle, integration acceptance, completion, Git/VCS, external effects, and
authorized GUI/browser/Computer Use. Independent Assignments can run in parallel;
dependent work and shared write seams are serialized. Post-integration CI and
release verification follow babysit-ci against the exact ref/SHA; pending is
not success.

Profiles select the configured Root and specialist route identities and their
reasoning effort. Routing identity is separate from instruction behavior: all
live skills and generated instructions target GPT-6-family behavior.
HolyCodex's `writing-instructions` skill owns model-facing instruction changes.
Historical route and profile values remain only in explicit migration or
cleanup handling for old installations.

Windows installations require verified Git for Windows Bash. Context7 is
required on every platform and installed as ctx7@latest through the same
package-manager family that launched HolyCodex. See
[installation](docs/INSTALLATION.md) for setup, ownership, and repair behavior.

The native surface has one canonical leaf for every route: `Explorer.lookup`,
`Explorer.trace`, `Librarian.lookup`, `Librarian.research`,
`Worker.mechanical`, `Worker.implementation`, `Worker.integration`,
`Worker.operations`, `Worker.validation`, `Worker.debugging`, `Reviewer.plan`, `Reviewer.code`, and
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
