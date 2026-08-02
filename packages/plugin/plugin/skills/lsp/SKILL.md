---
name: lsp
description: Use when coding needs semantic diagnostics, definitions, references, symbols, or safe rename from a configured server; do not use for text/syntax search or server install. Produces semantic locations, diagnostics, or workspace edits.
---

# LSP

Call `lsp` MCP tools, never shell commands:

- `lsp.status`: server state.
- `lsp.diagnostics`: file/dir diagnostics; prefer `severity: "error"` after edits.
- `lsp.goto_definition`, `lsp.find_references`: definition/usages.
- `lsp.symbols`: document outline/workspace search.
- `lsp.prepare_rename`, `lsp.rename`: validate/apply workspace rename.

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

If diagnostics report a missing server, call `lsp.status` first.
