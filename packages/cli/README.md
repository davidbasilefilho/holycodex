# holycodex

HolyCodex installer and doctor CLI. Plugin prompts, skills, agents, hooks, and runtime assets ship through the exact-version `@holycodex/plugin` dependency.

```sh
bunx holycodex@dev install
bunx holycodex@dev doctor
```

Use `holycodex --help` for commands, autonomy options, and service tiers. `--fast` selects the fast tier; `--no-fast` or omitting both tier flags selects the default. Stable releases use `bunx holycodex`; development releases use npm's `dev` dist-tag.

Default and `--no-codex-autonomous` installs use Codex Approve for me semantics: `approval_policy = "on-request"`, `approvals_reviewer = "auto_review"`, and `sandbox_mode = "workspace-write"`. Autonomous modes omit the reviewer and retain their documented sandbox behavior. The optional `holycodex-config` permission profile remains available without forcing `default_permissions`, so users may select Full access or another profile.

Install also attempts to add or enable the official `codex-security@openai-curated` plugin through structured Codex CLI commands. External availability failures are non-fatal and reported in human and JSON results. Cleanup leaves this independent official plugin installed. Build Web Apps remains separately managed by Codex.

Repository, documentation, license, and security notices: https://github.com/davidbasilefilho/holycodex
