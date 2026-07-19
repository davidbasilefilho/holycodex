# codexslimedit

Codex-native MCP tools for compact UTF-8 file reads and validated exact or line-range edits. Runs on Node.js 20+ and Bun.

## Use

```sh
npx codexslimedit
# or
bunx codexslimedit
```

The MCP server exposes:

- `read`: returns a root-relative path and file content without footer boilerplate.
- `edit`: replaces one unique exact string or a 1-based inclusive line range such as `55-64`, then returns `OK <path>`.

Both tools constrain access to the server working directory. Reads reject non-UTF-8, NUL-containing, missing, non-file, traversal, and symlink-escape targets. Edits validate before writing, reject ambiguous matches and invalid ranges, preserve line endings and file mode, and use same-directory atomic replacement.

## Codex adaptation

This package adapts ideas from OpenSlimEdit for supported Codex extension surfaces. Codex plugins cannot replace descriptions of native tools or replace model-facing `PostToolUse` output, and Codex native patch editing has no OpenCode `oldString` contract. `codexslimedit` therefore provides separate concise MCP tools and makes no upstream token-saving claim.
