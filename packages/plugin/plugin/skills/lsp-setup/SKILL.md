---
name: lsp-setup
description: Use when user requests language-server setup or required LSP is missing; do not use when a server works or for general dependencies. Produces one minimum verified server config; unlike lsp it establishes capability.
---

# LSP Setup

Never install silently.

1. Detect language, root, package manager, existing server/config.
2. Run `scripts/detect-lsp.ts` or inspect `scripts/lsp-server-table.ts` for server, command, extensions, install hint.
3. Prefer maintained project-local server; preserve config.
4. Ask before machine/network change unless setup was authorized.
5. Add minimum command/args/extensions; root markers only when needed.
6. Verify executable/version, start server, diagnose one representative file.
7. Report server, version, config path, result.

No duplicate server per extension without explicit priority, global install when local works, or broad editor changes.
