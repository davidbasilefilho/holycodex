# Installation

Codex owns plugin installation state. HolyCodex uses Codex's native plugin
management and does not stage duplicate plugin copies, rewrite unrelated
settings, or maintain a second activation registry.

HolyCodex installs one native leaf for each canonical identity:
`Explorer.map`, `Explorer.lookup`, `Explorer.trace`, `Librarian.lookup`,
`Librarian.research`, `Worker.mechanical`, `Worker.implementation`,
`Worker.integration`, `Worker.operations`, `Worker.validation`,
`Worker.debugging`, `Reviewer.plan`, `Reviewer.code`, and `Reviewer.artifact`.
Each leaf has one TOML under
`<CODEX_HOME>/holycodex/agents/` and one `config.toml` registration. Root is
the parent session configured in `config.toml`; `agents/root.toml` is never
created or registered. Migration and removal may delete only a known,
unchanged HolyCodex-owned legacy Root file.

## Required tooling

On Windows, installation, the package migration, and doctor require a verified Git for Windows
Bash executable. HolyCodex checks `C:\\Program Files\\Git\\bin\\bash.exe`
first and then a `bash` resolved from `PATH`; it accepts only a compatible Git
for Windows installation. When none is healthy, install or the package migration runs
`winget install --id Git.Git -e --source winget` and verifies the executable
directly. Failure returns an actionable capability error. Existing Git for
Windows state is shared user/system state and is not replaced, reconfigured,
or removed merely because HolyCodex uses it.

Context7 is required for current technical documentation. The supported
launcher is Bun, and HolyCodex derives Bun's global bin directory with
`bun pm bin -g`, installs with `bun add -g ctx7@latest`, and verifies the
package root, package-owned executable, shim, and exact version. A `ctx7`
found through a generic `PATH`, mise, npm, pnpm, or another Bun installation
is ignored and left untouched; mise configuration is never edited. An
unavailable Bun global installation is reported during preflight before any
managed configuration is changed. HolyCodex never runs `ctx7 setup`.

## Install

The supported public path is:

```sh
bunx holycodex install
```

Configure routing, service handling, and optional plugins explicitly:

```sh
bunx holycodex install --yes \
  --profile default --tier standard \
  --frontend --security --computer-use
```

The live profiles are `low`, `default`, and `high`; `default` is the
recommended routing. New input uses `--profile`; the former routing flag is
not part of the current user surface. Existing serialized `plan` fields
migrate losslessly to `profile`. Persisted `plus-low`, `plus`, and `plus-high` values
migrate to `low`, `default`, and `high`. Legacy `go`, `pro-5x`, and `pro-20x`
values are recognized as removed and require an explicit replacement; they are
never silently reinterpreted. The profile controls native subagent routing
only. The tier is independent.
Optional plugins are frontend tooling, Security, and Computer Use. The
CLI preflights the selected capabilities and runtime compatibility, invokes
only the required native Codex marketplaces/providers, verifies readback, and
atomically stores one HolyCodex-owned configuration under
`$CODEX_HOME/holycodex`. Frontend and Security are selected by default;
Computer Use is disabled unless selected. Every selected capability and
`--add-plugin` ID must verify as installed and enabled or installation fails.
An unrelated unavailable official-provider marketplace does not abort a valid
selected set. Failed installs leave a recoverable transaction; retrying
reconciles it before publishing new state.

Root's selected model, reasoning effort, service tier, developer instructions,
required feature flags, and every canonical leaf registration converge in
`<CODEX_HOME>/config.toml`. With `--computer-use`, the official capability is
enabled, and Root receives the conditional directive that interactive GUI,
browser, and Computer Use execution is Root-only. Without that option, the
directive is absent and the capability is unavailable; it is never represented
as delegateable work or a delegation fallback. Leaves never receive GUI,
browser, or Computer Use access.

Profiles select configured Root and specialist route identities with the task
effort matrix in [BEHAVIOR.md](BEHAVIOR.md). Every generated instruction
targets GPT-6-family behavior regardless of a temporary routing model ID.
Root uses `gpt-6-sol` for low/default and `gpt-6-astra` for high; native specialist route files use `gpt-6-luna`. Root dispatches concrete registered
`Role.task` identities from the canonical inventory; role families and generic
built-in agent types are not dispatch targets.
HolyCodex manages the
canonical scalar `features.context_management` and sets it to `true` for Root
and every generated leaf because Codex does not enable it by default.
The package migration converts owned historical
`features.context_management.experimental_mode` state to the scalar key;
removal restores the recorded prior value when unchanged.

Official OpenAI plugin identities may be observed as either
`openai-curated` or the recognized `openai-curated-remote` marketplace. The
allowlist covers build-web-apps and codex-security; arbitrary same-name
third-party providers remain untrusted.

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
groups only actual managed conflicts and then shows one final review with the
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
