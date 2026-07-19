# Third-party notices

HolyCodex began as a one-time hard fork of `code-yeongyu/oh-my-openagent` and preserves its Git history. The repository uses the same Sustainable Use License 1.0. Third-party components retain their original licenses.

The caveman communication concept is adapted from [juliusbrussee/caveman](https://github.com/JuliusBrussee/caveman). Copyright belongs to its authors and contributors; use remains subject to that project's published license.

`packages/plugin/plugin/skills/remove-slop` adapts the scoped behavior-locking process from [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) `remove-ai-slops` at commit `dec381ed201a1326883db9f42bdb3c2add91b299`, under the upstream Sustainable Use License 1.0. OpenCode-specific task mechanics were not copied. [pols.dev/slop.md](https://pols.dev/slop.md) is cited as frontend anti-slop guidance; no text is bundled from that page, and its visual classifications apply only to matching frontend scope.

HolyCodex agent routing and orchestration instructions adapt bounded-role, task-ownership, non-overlapping-write, session-reuse, and verification-planning concepts from [alvinunreal/oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) at commit `7bc7b56856ee693812d87d68615757d4d1c2e218`, principally `src/agents/{orchestrator,explorer,librarian,fixer}.ts`, `src/skills/verification-planning/SKILL.md`, and `docs/background-orchestration.md`. OpenCode runtime APIs, hooks, council, ACP, companion, and background-session mechanics were not copied. Upstream material is MIT licensed; its license is preserved in `packages/plugin/plugin/LICENSE-OH-MY-OPENCODE-SLIM-MIT.txt`.

The bundled LSP runtime at `packages/plugin/plugin/runtime/lsp.js` is derived from `code-yeongyu/oh-my-openagent`'s `lsp-tools-mcp`. Copyright (c) 2026 Yeongyu Kim; used under the MIT License preserved at `packages/plugin/plugin/runtime/LICENSE-LSP-MIT.txt`.

The `codexslimedit` package and HolyCodex integration adapt compact-read and line-range edit behavior from [ASidorenkoCode/openslimedit](https://github.com/ASidorenkoCode/openslimedit) at commit `d5014929d6f66729b887df74a65ed6d22c3b522b`. Copyright (c) 2026 Artur; used under the MIT License preserved in both published packages. OpenCode hook APIs and token-saving claims were not copied.
