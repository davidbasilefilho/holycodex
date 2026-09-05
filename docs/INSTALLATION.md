# Installation

Codex owns plugin installation state. HolyCodex uses Codex's native plugin
management and does not stage duplicate plugin copies, rewrite unrelated
settings, or maintain a second activation registry.

HolyCodex installs one native leaf for each canonical identity:
`Explorer.lookup`, `Explorer.trace`, `Librarian.lookup`,
`Librarian.research`, `Worker.mechanical`, `Worker.implementation`,
`Worker.integration`, `Worker.operations`, `Reviewer.plan`, `Reviewer.code`,
and `Reviewer.artifact`. Each leaf has one TOML under
`<CODEX_HOME>/holycodex/agents/` and one `config.toml` registration. Root is
the parent session configured in `config.toml`; `agents/root.toml` is never
created or registered. Migration and removal may delete only a known,
unchanged HolyCodex-owned legacy Root file.

## Install

The supported public path is:

```sh
bunx holycodex install
```

Configure routing, service handling, and optional plugins explicitly:

```sh
bunx holycodex install --yes \
  --profile default --tier standard \
  --work --frontend --security --computer-use
```

The live profiles are `low`, `default`, and `high`; `default` is the
recommended routing. New input uses `--profile`; the former routing flag is
not part of the current user surface. Existing serialized `plan` fields
migrate losslessly to `profile`. Persisted `plus-low`, `plus`, and `plus-high` values
migrate to `low`, `default`, and `high`. Legacy `go`, `pro-5x`, and `pro-20x`
values are recognized as removed and require an explicit replacement; they are
never silently reinterpreted. The profile controls native subagent routing
only. The tier is independent.
Optional plugins are Work, frontend tooling, Security, and Computer Use. The
CLI preflights the selected capabilities and runtime compatibility, invokes
only the required native Codex marketplaces/providers, verifies readback, and
atomically stores one HolyCodex-owned configuration under
`$CODEX_HOME/holycodex`. Frontend and Security are selected by default; Work
and Computer Use are disabled unless selected. Every selected capability and
`--add-plugin` ID must verify as installed and enabled or installation fails.
An unrelated unavailable official-provider marketplace does not abort a valid
selected set. Failed installs leave a recoverable transaction; retrying
reconciles it before publishing new state.

Root's selected model, reasoning effort, service tier, developer instructions,
required feature flags, and the eleven leaf registrations converge in
`<CODEX_HOME>/config.toml`. With `--computer-use`, the official capability is
enabled, and Root receives the conditional directive that interactive GUI,
browser, and Computer Use execution is Root-only. Without that option, the
directive is absent and leaves retain the native capability restriction.

The live root/session model is `gpt-6-astra` at low, medium, or high
reasoning for the selected profile. Specialists use `gpt-5.6-luna` with the
task effort matrix in [BEHAVIOR.md](BEHAVIOR.md). HolyCodex manages
`features.context_management.experimental_mode` and sets it to `true` because
Codex does not enable it by default. Upgrade preserves the managed key and
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

## Doctor

`doctor` reads the effective runtime rather than only the installation record.
It reports missing or drifted Root managed keys, each canonical registration
and leaf TOML, stale owned legacy Root files, selected capability health, and
preparing or conflicted transactions. It reports a resolved allowlisted
official identity (for example `openai-curated-remote`) as healthy instead of
requiring the canonical marketplace spelling.
