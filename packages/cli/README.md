# holycodex

HolyCodex installer and doctor CLI. Plugin prompts, skills, agents, hooks, and runtime assets ship through the exact-version `@holycodex/plugin` dependency.

```sh
bunx holycodex@dev install
bunx holycodex@dev doctor
```

Use `holycodex --help` for commands, autonomy options, routing plans, and service tiers. `--fast` selects Fast for generated agents, `--fast-all` selects Fast for Root and generated agents, and `--no-fast` or omitting Fast flags selects Standard. Fast uses `2.5×` subscription usage for about `1.5×` output-token speed without a quality gain. Stable releases use `bunx holycodex`; development releases use npm's `dev` dist-tag.

On a fresh installation, omitting autonomy flags seeds Codex Approve for me semantics: `approval_policy = "on-request"`, `approvals_reviewer = "auto_review"`, and `sandbox_mode = "workspace-write"`. On an existing installation, omitting autonomy flags preserves the complete current permission selection. `--no-codex-autonomous`, `--codex-autonomous`, and `--dangerous-codex-autonomous` explicitly replace that selection with their documented modes. HolyCodex never generates `default_permissions` or selects a named permission profile.

Install also attempts to add or enable the official `codex-security@openai-curated` plugin through structured Codex CLI commands. If no global Codex CLI is available, HolyCodex can use the active Bun executable or a supported npm/pnpm package runner. External availability failures are non-fatal and reported in human and JSON results. Cleanup leaves this independent official plugin installed. Build Web Apps remains separately managed by Codex.

Repository, documentation, license, and security notices: https://github.com/davidbasilefilho/holycodex
