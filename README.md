# HolyCodex

Codex-only toolkit tuned for low ChatGPT Plus usage. No OpenCode runtime, configuration, provider, or update path is included.

```sh
bunx holycodex install
bunx holycodex cleanup
npx holycodex install
npx holycodex cleanup
```

Installation is noninteractive, backs up existing Codex files under the OS temporary directory, preserves unrelated settings, and uses atomic configuration writes. Add `--codex-autonomous` for autonomous permissions or `--json` for structured output.
