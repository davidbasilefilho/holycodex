# Implementation notes

## Codex port of OpenSlimEdit

- Source: `https://github.com/ASidorenkoCode/openslimedit`
- Inspected revision: `d5014929d6f66729b887df74a65ed6d22c3b522b` (`v1.0.4` source state, inspected 2026-07-19)
- License: MIT, copyright 2026 Artur. Derived behavior must retain the upstream notice in package and repository third-party notices.
- Upstream behavior: OpenCode hooks shorten native tool descriptions, compact read/edit output, and expand an edit `oldString` containing a 1-based line or inclusive line range.
- Codex constraint: plugins cannot replace descriptions of Codex-native tools. `PreToolUse` can replace supported tool arguments, but `PostToolUse` cannot replace the model-facing tool result. Codex native edits use patches rather than OpenCode's `oldString` contract.
- Adaptation: expose compact `read` and range-aware `edit` as short-schema MCP tools. Keep native Codex tools available as fallback. Do not claim OpenSlimEdit's token-saving percentages without separate Codex benchmarks.
- Safety: resolve paths inside the declared workspace root, reject symlink escapes and ambiguous exact matches, preserve newline style, and complete writes atomically when the platform permits it.
- Multi-agent discovery: installed Codex reports `multi_agent` as stable and enabled, while `multi_agent_v2` is under development and disabled by default. The boolean override `features.multi_agent_v2=true` is accepted by the installed binary; nested community configuration is not treated as a stable public contract.
