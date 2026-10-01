# Installation

Codex owns plugin installation state. HolyCodex uses Codex's native plugin
management and does not stage duplicate plugin copies, rewrite unrelated
settings, or maintain a second activation registry.

HolyCodex installs one native leaf for each canonical identity:
`Explorer.map`, `Explorer.lookup`, `Explorer.trace`, `Librarian.lookup`,
`Librarian.research`, `Worker.mechanical`, `Worker.implementation`,
`Worker.integration`, `Worker.operations`, `Worker.validation`,
`Worker.debugging`, `Worker.visual`, `Reviewer.visual`, `Reviewer.code`,
`Reviewer.testing`, `Reviewer.audit`, `Reviewer.security`, and
`Reviewer.artifact`.
Each leaf has one TOML under
`<CODEX_HOME>/holycodex/agents/` and one `config.toml` registration. Root is
the parent session configured in `config.toml`; `agents/root.toml` is never
created or registered. Migration and removal may delete only a known,
unchanged HolyCodex-owned legacy Root file.

## Codex permissions

Installation defines the `holycodex` Codex permission profile with workspace
read/write access, network access, live web search, and automatic review for
eligible permission requests. Codex may request narrowly scoped additional
filesystem access when work requires paths outside the workspace. A fresh
HolyCodex installation selects this profile once; later updates preserve the
user's current Codex permission selection.

## Optional tooling

On Windows, Codex selects the shell environment for its commands. HolyCodex
does not require, install, or verify Git for Windows Bash.

Context7 is optional. HolyCodex accepts a usable `ctx7` on the effective
`PATH`. If none is available, it attempts to install `ctx7@latest` with Bun.
Registry, installation, or managed verification failure produces a warning
and does not prevent HolyCodex installation. HolyCodex never runs `ctx7 setup`.

## Install

The supported public path is:

```sh
bunx holycodex install
```

Configure routing, service handling, and optional plugins explicitly:

```sh
bunx holycodex install --yes \
  --profile default --tier standard \
  --sites --browser-use --computer-use
```

The live profiles are `low`, `default`, and `high`; `default` is the
recommended routing. New input uses `--profile`; the former routing flag is
not part of the current user surface. Existing serialized `plan` fields
migrate losslessly to `profile`. Persisted `plus-low`, `plus`, and `plus-high` values
migrate to `low`, `default`, and `high`. Legacy `go`, `pro-5x`, and `pro-20x`
values are recognized as removed and require an explicit replacement; they are
never silently reinterpreted. The profile controls native subagent routing
only. The tier is independent.
Frontend and Security are required capabilities. ChatGPT Sites and Browser Use
are optional and default on; Computer Use is optional and default off. Sites
availability can depend on account, region, workspace policy, or supported
Codex surface. Browser Use is provisioned by Codex Desktop; the CLI preserves
any host state and records the selection without installing, configuring, or
claiming the provider. Its actual availability is checked only at the Codex
surface where a specialist uses it. Computer Use has stronger platform/surface
restrictions and greater external-action capability. The CLI preflights
provider-backed capabilities and runtime compatibility, invokes only their
canonical official Codex providers, verifies readback, and publishes routing,
capability state, plugins, and generated configuration coherently. Selected
unsupported provider-backed capabilities and `--add-plugin` IDs fail
explicitly; no silent omission or substitute is accepted. An unrelated
unavailable official-provider marketplace does not abort a valid selected set.
Failed installs leave a recoverable transaction; retrying reconciles it before
publishing new state.

Root's selected model, reasoning effort, service tier, developer instructions,
required feature flags, and every canonical leaf registration converge in
`<CODEX_HOME>/config.toml`. When Browser Use or Computer Use is enabled and
available, canonical shared specialist policy carries its applicable
directives. Root decides when the capability is needed, delegates execution
through the applicable `Role.task`, and accepts terminal evidence. Tool
availability does not grant authority. Unsupported selections fail explicitly
without fallback.

Profiles select configured Root and specialist route identities with the task
effort matrix in [BEHAVIOR.md](BEHAVIOR.md). Every generated instruction
targets GPT-6-family behavior regardless of a temporary routing model ID.
Root uses `gpt-6.1-sol` at low, medium, and medium reasoning effort for the
`low`, `default`, and `high` profiles respectively; native specialist route
files use `gpt-6-luna`. Root dispatches concrete registered
`Role.task` identities from the canonical inventory; role families and generic
built-in agent types are not dispatch targets.
HolyCodex manages
`features.context_management.experimental_mode = true` for Root and every
generated leaf. Removal restores the recorded prior value when unchanged.

The installer recognizes `openai-curated` and `openai-curated-remote` as
equivalent only for the allowlisted build-web-apps and codex-security plugins.
Browser, Computer Use, and Sites use their canonical `openai-bundled` provider
identities; Computer Use also accepts its supported `unified-computer-use` migration
identity. Same-name third-party providers remain untrusted.

Interactive install resolves Codex home internally and does not ask for a
`CODEX_HOME` path. Use `--codex-home <absolute-path>` only for explicit
non-interactive isolation, diagnostics, or recovery. The CLI keeps
the selected profile, tier, optional capabilities, and additional plugin IDs
in `$CODEX_HOME/holycodex/install.toml`. That file contains only
`schema_version = 1`, the profile, canonical service tier, capabilities, and
additional plugins; ownership, transaction, derived state, and configuration
contents remain outside it. Writes replace the file atomically, so a failed
install or package migration preserves the previous options file and unrelated user
state.

Install and internal migration collect options, load the current managed state,
and run a complete preflight before applying changes. Interactive conflict review
groups only actual managed conflicts, defaults to Replace, and scrolls the complete
list within the terminal viewport. Replacement backs up only replaced entries,
preserves unrelated configuration, and removes invalid managed entries when required.
Interrupted installs reconcile owned generation artifacts safely on retry. It then
shows one final review with the
selected options, conflict count, and planned tool operations. The approved
transaction applies without another prompt. The internal migration boundary
reuses persisted choices unless a caller supplies a reviewed replacement.

Legacy installations without `install.toml` are reconstructed from safe
managed-state evidence. Only choices that cannot be inferred are requested;
missing legacy options alone are not an error. A successful migration writes
the new options file. `--json` never opens a terminal UI and reports unresolved
choices as an error. Non-TTY runs need complete explicit options (or `--yes`)
and never prompt. `--yes` accepts safe managed replacements while preserving
foreign tools, plugins, and configuration.

## Remove

Remove only the HolyCodex-owned installation through the same native boundary:

```sh
bunx holycodex remove --yes
```

Removal verifies ownership before deleting the managed configuration and the
corresponding native HolyCodex plugin state. It also removes HolyCodex-owned
role registrations and restores managed configuration values where the
installation recorded a prior state, including the context-management setting
when it is unchanged. It never removes unrelated Codex plugins or settings. An
uncertain native result is reported and is not blindly repeated.

Legacy persisted Work selections are read only for migration cleanup and are
not projected as a live capability. Document, PDF, presentation, spreadsheet,
and template plugins remain shared user-owned state and are preserved during
the package migration and removal.

## Doctor

`doctor` reads the effective runtime rather than only the installation record.
It reports missing or drifted Root managed keys, each canonical registration
and leaf TOML, stale owned legacy Root files, selected capability health, and
preparing or conflicted transactions. It reports a resolved allowlisted
official identity (for example `openai-curated-remote`) as healthy instead of
requiring the canonical marketplace spelling.
It does not install, update, or repair optional tooling. Missing Context7 is
reported separately from core Codex target health.
