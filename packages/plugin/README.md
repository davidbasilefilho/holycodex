# @holycodex/plugin

Static HolyCodex Codex plugin payload: prompts, skills, agents, hooks, notices, and generated runtime assets. See the repository [architecture documentation](../../docs/ARCHITECTURE.md).

Every bundled skill ships explicit `agents/openai.yaml` metadata using the `HolyCodex: <Skill Name>` display brand while preserving lowercase machine identifiers.

Most users should run the `holycodex` CLI instead of installing this package directly. The CLI depends on the exact matching plugin version, applies the selected Luna and Sol routing plan, and resolves its installed asset root through this package's public entry point.

Repository, documentation, license, and security notices: https://github.com/davidbasilefilho/holycodex
