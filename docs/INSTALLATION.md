# Installation

Codex owns plugin installation state. HolyCodex uses Codex's native plugin
management and does not stage duplicate plugin copies, rewrite unrelated
settings, or maintain a second activation registry.

## Install

The supported public path is:

```sh
bunx holycodex install --yes
```

Configure routing, service handling, and optional plugins explicitly:

```sh
bunx holycodex install --yes \
  --plan plus --tier standard \
  --work --frontend --security --computer-use
```

The plan controls native subagent routing only. The tier is independent.
Optional plugins are Work, frontend tooling, Security, and Computer Use. The
CLI validates each selection, invokes native Codex plugin management, verifies
readback, and atomically stores one HolyCodex-owned configuration under
`$CODEX_HOME/holycodex`. Explicit capability selections and `--add-plugin` IDs
fail closed when native installation cannot verify them. The implicit
first-install Frontend and Security defaults remain selected and are recorded
as `missing` or `uncertain` with deterministic warnings when their providers
are unavailable, so a later reinstall can recover them.

Use `--codex-home <absolute-path>` for an isolated installation. The CLI keeps
the selected plan, tier, optional plugin state, version, and configuration
digest; Codex remains the owner of plugin files and marketplace state.

## Remove

Remove only the HolyCodex-owned installation through the same native boundary:

```sh
bunx holycodex remove --yes
```

Removal verifies ownership before deleting the managed configuration and the
corresponding native HolyCodex plugin state. It never removes unrelated Codex
plugins or settings. An uncertain native result is reported and is not blindly
repeated.
