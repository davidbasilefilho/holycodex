# HolyCodex

The public `holycodex` CLI composes the workspace installer, doctor, cleanup,
version, and workflow lifecycle commands. The normative command contract is
in the repository [CLI contract](../../docs/CLI.md).

The Codex plugin is installed officially with `codex plugin marketplace add`
followed by `codex plugin add holycodex@holycodex`. Use `bunx holycodex` only for the
standalone CLI, including diagnostics and legacy payload repair.
