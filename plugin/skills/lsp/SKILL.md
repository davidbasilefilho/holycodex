---
name: lsp
description: Use LSP diagnostics, definitions, references, symbols, or safe rename.
---

# LSP

Call `lsp` MCP tools, never their names as shell commands.

## Tools

- `lsp.status`: server state.
- `lsp.diagnostics`: file or directory diagnostics; prefer `severity: "error"` after edits.
- `lsp.goto_definition`: symbol definition.
- `lsp.find_references`: workspace usages.
- `lsp.symbols`: document outline or workspace symbol search.
- `lsp.prepare_rename`: rename validity.
- `lsp.rename`: workspace rename edit.

## Config

Project config lives at `.codex/lsp-client.json`; user config lives at `~/.codex/lsp-client.json`.

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

Use `lsp.status` first when diagnostics report a missing language server.
