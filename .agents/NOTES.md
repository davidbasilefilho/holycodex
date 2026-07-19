# Implementation notes

## Codex port of OpenSlimEdit

- Source: `https://github.com/ASidorenkoCode/openslimedit`
- Inspected revision: `d5014929d6f66729b887df74a65ed6d22c3b522b` (`v1.0.4` source state, inspected 2026-07-19)
- License: MIT, copyright 2026 Artur. Derived behavior must retain the upstream notice in package and repository third-party notices.
- Upstream behavior: OpenCode hooks shorten native tool descriptions, compact read/edit output, and expand an edit `oldString` containing a 1-based line or inclusive line range.
- Codex constraint: plugins cannot replace descriptions of Codex-native tools. `PreToolUse` can replace supported tool arguments, but `PostToolUse` cannot replace the model-facing tool result. Codex native edits use patches rather than OpenCode's `oldString` contract.
- Adaptation: expose compact `read_file` and `apply_patch` MCP tools. Codex 0.144.4 has native `apply_patch` but no model-facing read tool; its remote filesystem protocol uses `read_file`. MCP names remain server-qualified and cannot overwrite native registrations. HolyCodex gives these MCP tools mandatory priority for workspace reads and writes. `apply_patch` accepts native Add/Update/Delete envelopes plus compact exact or line-range replacements. Do not claim OpenSlimEdit's token-saving percentages without separate Codex benchmarks.
- Safety: resolve paths inside the declared workspace root, reject symlink escapes and ambiguous exact matches, preserve newline style, and complete writes atomically when the platform permits it.
- Edit protocol: reserve numeric `oldString` values such as `2` and `2-3` for inclusive 1-based ranges before exact matching. Agents targeting numeric content must provide a larger unique exact string. A terminal line ending in a range replacement terminates the replacement and must not create an extra blank line.
- Runtime compatibility: npm-backed CodexSlimEdit invocations use `npx.cmd` on native Windows because the shared process runner launches without a shell; other npm platforms use `npx`, and Bun uses `bunx`.
- Release channels: stable HolyCodex installs resolve `codexslimedit@latest`; `-dev.` versions resolve `codexslimedit@dev`. The dev workflow temporarily assigns CodexSlimEdit the matching unique dev version and publishes it before the dev CLI while preserving CodexSlimEdit's independent stable version.
- Multi-agent discovery: installed Codex reports `multi_agent` as stable and enabled, while `multi_agent_v2` is under development and disabled by default. The boolean override `features.multi_agent_v2=true` is accepted by the installed binary; nested community configuration is not treated as a stable public contract.
