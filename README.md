# HolyCodex

Codex-only toolkit tuned for low ChatGPT Plus usage. No OpenCode runtime, configuration, provider, or update path is included.

```sh
bunx holycodex install
bunx holycodex cleanup
npx holycodex install
npx holycodex cleanup
```

Installation is noninteractive, backs up existing Codex files under the OS temporary directory, preserves unrelated settings, and uses atomic configuration writes. Add `--codex-autonomous` for autonomous permissions or `--json` for structured output.

## What installs

- `plugin/skills/`: 18 on-demand skills. Includes compressed OMO-derived programming/debugging/frontend/LSP workflows, workspace `caveman`, `compress`, `define-goal`, `handoff`, and `tdd`. Frontend includes GPT Taste premium editorial mode.
- `plugin/agents/`: `explorer` for narrow internal inspection, `librarian` for current external sources, `worker` for bounded isolated implementation. Primary agent keeps control; subagents exist only to reduce cost, never to simulate an organization.
- `plugin/hooks/`: readiness, OMO-style intent line, Windows Git Bash recommendation, comment check, targeted LSP guidance, and scoped rule loading/reset.
- `plugin/.mcp.json`: `git_bash` for Windows Bash work, `lsp` for semantic code intelligence, `grep_app` for public code examples, and `context7` for current library docs.
- `plugin/runtime/`: prebuilt Node-compatible CLI, hooks, Git Bash MCP, and LSP MCP. No Bun runtime required after installation.

Skill and agent descriptions state their trigger. `define-goal`, `plan`, and `plan-review` are explicit-only. The generated config limits concurrency to two; Sol/Terra use low or medium reasoning, while Luna also permits high.

## Layout

- `src/`: installer, cleanup, CLI, readiness, and scoped-rule source.
- `packages/`: local Git Bash and LSP MCP source.
- `plugin/`: shipped Codex plugin—skills, agents, hooks, MCP manifest, runtime.
- `test/`: installer, catalog, rules, bootstrap, and CLI tests.
