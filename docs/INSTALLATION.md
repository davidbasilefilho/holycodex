# Installation

Codex owns plugin installation state. HolyCodex does not stage plugin copies, rewrite a personal marketplace, maintain activation pointers, or prune Codex plugin artifacts.

The native equivalent is:

```sh
codex plugin marketplace add davidbasilefilho/holycodex
codex plugin add holycodex@holycodex
```

`holycodex install` is the supported configuration frontend. It validates HolyCodex options, invokes those native operations through the discovered Codex executable, installs selected provider plugins the same way, reads plugin state back, and fails unless every requested plugin is installed and enabled. It does not invent Codex plugin arguments for HolyCodex settings.

```sh
bunx holycodex@latest install --yes --plan plus --work
```

After native readback succeeds, the CLI atomically stores one HolyCodex-owned configuration at `$CODEX_HOME/holycodex/active.json`. It contains plan, tier, autonomy, concurrent-specialist selection, optional capabilities, provider IDs, capability health, version, and a configuration digest. Plugin files and marketplace state remain Codex-owned.

Setup also enables Codex's `default_mode_request_user_input` feature, verifies
that native `request_user_input` is effective in Default mode while preserving
unrelated Codex configuration, and writes derived native `{Role}.{task}`
profiles under `$CODEX_HOME/agents`. An uncertain plugin or configuration
effect is reported without blind retry.

`doctor` is read-only: it validates the HolyCodex configuration and compares requested plugin state with Codex's live list. `cleanup` removes only HolyCodex-owned configuration, terminal run state, or expired generated workflows for the selected scope; it never removes Codex plugin state.
