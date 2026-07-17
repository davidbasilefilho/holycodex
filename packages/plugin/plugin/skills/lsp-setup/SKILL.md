---
name: lsp-setup
description: Use when a task needs language-server installation or configuration because the user requests setup or the required LSP is missing; do not use when an existing server works or for general dependency setup. Produces one minimal verified server configuration; unlike lsp it establishes capability rather than using it.
---

# LSP Setup

Use when user asks setup/install/configure, or required server is missing. Do not install silently.

1. Detect language, project root, package manager, existing server, and current `.codex/lsp-client.json` or project setting.
2. Run `scripts/detect-lsp.ts` or inspect `scripts/lsp-server-table.ts` for matching server, command, extensions, and install hint.
3. Prefer project-local maintained server. Preserve existing config.
4. If install changes machine or network state, ask unless user already authorized setup.
5. Add smallest config entry: command, args, extensions, root markers only when needed.
6. Verify executable, start server, run diagnostics on one representative file.
7. Report server, version, config path, verification result.

No duplicate server for same extension without explicit priority. No global install when project-local works. No broad editor configuration changes.
