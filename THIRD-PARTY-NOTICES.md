# Third-party notices

HolyCodex began as a one-time hard fork of `code-yeongyu/oh-my-openagent` and preserves its Git history. The repository uses the same Sustainable Use License 1.0. Third-party components retain their original licenses.

The caveman communication concept is adapted from `juliusbrussee/caveman`, with attribution preserved here. Copyright belongs to its authors and contributors; used under its published license.

`plugin/skills/remove-slop` adapts the scoped behavior-locking process from `code-yeongyu/oh-my-openagent` `remove-ai-slops` at `dec381ed201a1326883db9f42bdb3c2add91b299`. OpenCode-specific task mechanics were not copied. `pols.dev/slop.md` is cited as frontend anti-slop guidance; its visual classifications are applied only to matching frontend scope.

HolyCodex agent routing and orchestration instructions adapt bounded-role, task-ownership, non-overlapping-write, session-reuse, and verification-planning concepts from `alvinunreal/oh-my-opencode-slim` at `7bc7b56856ee693812d87d68615757d4d1c2e218`, principally `src/agents/{orchestrator,explorer,librarian,fixer}.ts`, `src/skills/verification-planning/SKILL.md`, and `docs/background-orchestration.md`. OpenCode runtime APIs, hooks, council, ACP, companion, and background-session mechanics were not copied. Upstream material is MIT licensed; notice preserved in `plugin/LICENSE-OH-MY-OPENCODE-SLIM-MIT.txt`.

The bundled LSP runtime at `plugin/runtime/lsp.js` is derived from `code-yeongyu/oh-my-openagent`'s `lsp-tools-mcp`. Copyright (c) 2026 Yeongyu Kim; used under the MIT License preserved at `plugin/runtime/LICENSE-LSP-MIT.txt`.
