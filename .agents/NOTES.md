# Durable implementation notes

## Codex desktop custom permission selection

- Source: OpenAI Codex manual fetched 2026-07-29 and `openai/codex` desktop issues #22553, #28281, and #28776.
- Codex permission profiles use `default_permissions` plus `[permissions.<name>]`. The current Windows desktop app can show “Custom (config.toml)” for a named profile while still resolving execution from legacy `approval_policy` and `sandbox_mode` fields.
- HolyCodex writes the named `holycodex-config` profile to make `config.toml` the selected permission source in every installer mode. It temporarily retains the legacy fields so current desktop releases execute the intended default, autonomous, and explicitly dangerous policies.
- The named profile extends `:workspace` with networking enabled. This is a fail-safe fallback because custom profiles cannot extend `:danger-full-access`; unrestricted execution remains controlled by the explicit legacy dangerous mode.
- Remove the legacy compatibility layer only after the desktop app applies named permission profiles reliably on native Windows. Verify install, reinstall, cleanup restoration, CLI execution policy, and desktop selection before removal.
