# codexslimedit

Codex-native MCP tools for compact UTF-8 file reads and validated exact or line-range edits. Runs on Node.js 20+ and Bun.

## Use

```sh
npx codexslimedit
# or
bunx codexslimedit
```

The MCP server exposes:

- `read_file`: returns a root-relative path and file content without footer boilerplate.
- `apply_patch`: accepts Codex `*** Begin Patch` envelopes for `Add File`, `Update File`, and `Delete File`. It also retains a compact `filePath`/`oldString`/`newString` form for one unique exact replacement or inclusive line range such as `55-64`.

Both tools constrain access to the server working directory. Reads reject non-UTF-8, NUL-containing, missing, non-file, traversal, and symlink-escape targets. Patches create, update, and delete regular UTF-8 files; exact edits reject ambiguous matches and invalid ranges, preserve line endings and file mode, and use same-directory atomic replacement.

## Codex adaptation

This package adapts ideas from OpenSlimEdit for supported Codex extension surfaces. Codex qualifies MCP tool names with their server namespace, so the model-facing names are `mcp__codexslimedit__read_file` and `mcp__codexslimedit__apply_patch`; MCP cannot overwrite Codex's built-in `apply_patch` registration. HolyCodex instructions require these tools for workspace reads and writes. Native patch envelopes preserve familiar patch ergonomics, while the compact exact-replacement form reduces simple-edit arguments and results. No upstream token-saving percentage is claimed without Codex-specific benchmarks.
