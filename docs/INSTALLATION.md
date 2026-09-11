# Installation

Codex owns plugin installation state. HolyCodex uses Codex's native plugin
management and does not stage duplicate plugin copies, rewrite unrelated
settings, or maintain a second activation registry.

HolyCodex installs one native leaf for each canonical identity:
`Explorer.lookup`, `Explorer.trace`, `Librarian.lookup`,
`Librarian.research`, `Worker.mechanical`, `Worker.implementation`,
`Worker.integration`, `Worker.operations`, `Worker.validation`,
`Worker.debugging`, `Reviewer.plan`, `Reviewer.code`, and `Reviewer.artifact`.
Each leaf has one TOML under
`<CODEX_HOME>/holycodex/agents/` and one `config.toml` registration. Root is
the parent session configured in `config.toml`; `agents/root.toml` is never
created or registered. Migration and removal may delete only a known,
unchanged HolyCodex-owned legacy Root file.

## Required tooling

On Windows, install, upgrade, and doctor require a verified Git for Windows
Bash executable. HolyCodex checks `C:\\Program Files\\Git\\bin\\bash.exe`
first and then a `bash` resolved from `PATH`; it accepts only a compatible Git
for Windows installation. When none is healthy, install or upgrade runs
`winget install --id Git.Git -e --source winget` and verifies the executable
directly. Failure returns an actionable capability error. Existing Git for
Windows state is shared user/system state and is not replaced, reconfigured,
or removed merely because HolyCodex uses it.

Context7 is required for current technical documentation. HolyCodex derives
the package-manager family from launcher metadata and reconciles `ctx7@latest`
through that same family: `bunx` uses `bun add --global ctx7@latest`, `npx`
uses `npm install --global ctx7@latest`, and `pnpm dlx` uses
`pnpm add --global ctx7@latest`. Unknown managers fail explicitly. Verification
checks manager ownership, the resolved executable, and `ctx7 --version`, and
rejects a shadowing binary. Upgrade repairs version drift; doctor checks it.
Removal uninstalls Context7 only when HolyCodex recorded that it created the
same manager-owned installation. HolyCodex never runs `ctx7 setup`.

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
The current Root route is `gpt-6-astra`; native specialist route files use the
configured `gpt-5.6-luna` identity. Root dispatches concrete registered
`Role.task` identities from the canonical inventory; role families and generic
built-in agent types are not dispatch targets.
HolyCodex manages the
canonical scalar `features.context_management` and sets it to `true` for Root
and every generated leaf because Codex does not enable it by default.
Upgrade migrates owned historical
`features.context_management.experimental_mode` state to the scalar key;
removal restores the recorded prior value when unchanged.

Official OpenAI plugin identities may be observed as either
`openai-curated` or the recognized `openai-curated-remote` marketplace. The
allowlist covers build-web-apps and codex-security; arbitrary same-name
third-party providers remain untrusted.

Interactive install resolves Codex home internally and does not ask for a
`CODEX_HOME` path. Use `--codex-home <absolute-path>` only for explicit
non-interactive isolation, diagnostics, or recovery. The CLI keeps
the selected profile, tier, optional plugin state, version, and configuration
digest; Codex remains the owner of plugin files and marketplace state.

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
upgrade and removal.

## Doctor

`doctor` reads the effective runtime rather than only the installation record.
It reports missing or drifted Root managed keys, each canonical registration
and leaf TOML, stale owned legacy Root files, selected capability health, and
preparing or conflicted transactions. It reports a resolved allowlisted
official identity (for example `openai-curated-remote`) as healthy instead of
requiring the canonical marketplace spelling.
