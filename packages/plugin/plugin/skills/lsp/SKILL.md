---
name: lsp
description: Use when coding needs type-aware definitions, declarations, usages, diagnostics, symbols, or safe renames; do not use for text or syntax search or LSP setup. Produces semantic locations, diagnostics, or workspace edits.
---

# LSP

Call the bundled CLI through normal shell execution, never MCP:

`node runtime/lsp.js <command> [options] [--json]`

Commands are `status`, `diagnostics`, `definition`, `declaration`, `references`, `document-symbols`, `workspace-symbols`, `prepare-rename`, and `rename`. Source positions use `--file`, 1-based `--line`, and 0-based `--character`. Rename also requires `--new-name`; workspace symbols require `--query`. Use `--option value` or `--option=value`.

The CLI starts or reuses the bundled daemon automatically, returns structured machine-readable output with `--json`, exits nonzero on errors, applies bounded request timeouts, and reports daemon logs and socket diagnostics when unavailable.

Project config: `.codex/lsp-client.json`; user config: `~/.codex/lsp-client.json`.

```json
{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"]
    }
  }
}
```

If diagnostics report a missing server, run `status` first.
