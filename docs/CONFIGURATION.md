# Configuration

This document owns configuration precedence, profile and tier selection, optional
plugins, explicit paths, managed ownership, and compare-before-write behavior.
Runtime semantics remain in [BEHAVIOR.md](BEHAVIOR.md), CLI syntax remains in
[CLI.md](CLI.md), and secret exclusions remain in [SECURITY.md](SECURITY.md).

## Precedence

The effective configuration is resolved from strongest to weakest:

1. Explicit command input and approved caller overrides.
2. Trusted workspace configuration.
3. User configuration.
4. Safe built-in defaults.

Each layer is validated before it can override the next. Missing, malformed,
or untrusted values fail closed. Native subagents receive a read-only snapshot
and cannot write configuration.

## Native runtime projection

The managed projection writes Root's selected model, reasoning effort, service
tier, compact `developer_instructions`, required feature flags, and all eleven
canonical `agents."{Role}.{task}".config_file` registrations into
`<CODEX_HOME>/config.toml`. Root is the parent session in that file; no
`agents/root.toml` is generated or registered. Leaf TOMLs live under
`<CODEX_HOME>/holycodex/agents/` and use native controls for their model,
reasoning effort, service tier, sandbox, approval, network, and delegation
features. Worker network access is disabled for mechanical, implementation, and
integration tasks; only `Worker.operations` uses live access, and its task
contract requires a Root-supplied exact ref/SHA. Generated leaves do not set
`tool_output_token_limit`.

The role profile is the authority source. A task skill supplies branch-specific
workflow, while a delegation prompt supplies assignment facts. Runtime flags
enforce hard capability boundaries where Codex supports them; prose does not
stand in for a missing native control.

HolyCodex manages `features.context_management.experimental_mode` and writes
`true` because Codex does not enable it by default. Upgrade preserves the
managed key and removal restores the recorded prior value when the live value
is unchanged; a user edit is preserved and reported as drift. Intent, Plan,
and Assignment persistence remains independent repo-local work state.

Root MUST delegate every task, including trivial work, through a bounded
Assignment. Direct Root execution is limited to Git/VCS and Computer Use when
selected at installation. A passing `Reviewer.code` fixed-point review is
required after implementation or a major codebase change and before completion
or VCS. Root uses `request_user_input` for workflow Plan approval, installation
profile approval, remote/origin/server VCS mutations, public publication or
release, and ambiguity or missing material input; persist `needs_root_input`
when blocked.

## Profiles, tiers, and optional plugins

The profile catalog owns valid product profile names and native routes. A
profile controls routing only. Every live profile uses Root/session model
`gpt-6-astra` at its profile effort and specialist model `gpt-5.6-luna`; the
specialist task effort matrix is owned by [BEHAVIOR.md](BEHAVIOR.md). A profile
does not select a service tier or grant authority.

The valid profile names are `low`, `default`, and `high`; `default` is
recommended. New installation input uses `--profile`. Existing serialized
`plan` fields migrate losslessly to `profile`. Legacy `plus-low`, `plus`, and
`plus-high` migrate to `low`, `default`, and `high`; legacy `go` is recognized
and requires an explicit replacement. Removed `pro-5x` and `pro-20x` values
also require an explicit replacement. Historical names are never silently
reinterpreted as another live profile.

The service tier is an independent setting selected with `--tier`. It changes
service handling without changing the profile, route, authority, or proof
requirements. The valid tier names are `standard`, `fast`, and `fast-all`.

Optional plugins are explicit booleans for `work`, `frontend`, `security`, and
`computer_use`. On a first install, Work and Computer Use default to false while
frontend and Security default to true; an omitted selection otherwise inherits
the existing managed configuration. Availability never grants authority.
Explicitly selected or additionally requested plugins return a structured
denial when missing. Capability discovery only resolves marketplaces needed by
the selected set; an unrelated unavailable provider does not abort the install.
Every selected capability and additional plugin must verify as installed and
enabled or installation fails; no selected capability is recorded as a
successful unresolved state and no fallback is selected. Official
`openai-curated` and `openai-curated-remote` identities are equivalent only for
an allowlisted OpenAI plugin such as build-web-apps or codex-security; a
same-name third-party marketplace is not trusted.

## Paths and ownership

Codex home is resolved internally for interactive installation. The explicit
`--codex-home` option is reserved for non-interactive isolation, diagnostics,
or recovery and supplies an absolute path. Paths are traversal-free and never
broadened to a workspace root. HolyCodex owns only its configuration and the
native plugin state created for that installation. Codex owns the rest of its
plugin and configuration state.

## Managed writes

Every managed write carries an owner, schema, install identity, and digest.
Before destructive mutation, installation validates selected capabilities and
runtime compatibility, then records a recoverable transaction. The CLI
compares existing managed fields and refuses to overwrite a changed or foreign
value. Matching state is retained. Writes are atomic and validated before
persistence; an uncertain result is preserved and reported. Retrying
installation reconciles incomplete transaction state safely.

Removal applies the same ownership test and never deletes unrelated Codex
state.

## Secrets

No secret belongs in configuration, a CLI envelope, or diagnostic output. This
includes API keys, access tokens, cookies, passwords, private keys,
authorization headers, credential-bearing URLs, raw environment values, and
credential files. The complete policy is owned by [SECURITY.md](SECURITY.md).
