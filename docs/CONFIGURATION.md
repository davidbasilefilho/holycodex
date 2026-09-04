# Configuration

This document owns configuration precedence, plan and tier selection, optional
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
features. Generated leaves do not set `tool_output_token_limit`.

The role profile is the authority source. A task skill supplies branch-specific
workflow, while a delegation prompt supplies assignment facts. Runtime flags
enforce hard capability boundaries where Codex supports them; prose does not
stand in for a missing native control.

## Plans, tiers, and optional plugins

The plan catalog owns valid plan names and native routes. A plan controls
routing only. `go` keeps Terra/high for Root and uses the plus-low Luna leaf
route matrix; Plus and Pro plans select specialist routes. A plan does not
select a service tier or grant authority.

The valid plan names are `go`, `plus-low`, `plus`, `plus-high`, `pro-5x`, and
`pro-20x`.

The service tier is an independent setting selected with `--tier`. It changes
service handling without changing the plan, route, authority, or proof
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

`CODEX_HOME` defaults to `~/.codex`; `--codex-home` supplies an absolute,
isolated test or user path. Paths are traversal-free and never broadened to a
workspace root. HolyCodex owns only its configuration and the native plugin
state created for that installation. Codex owns the rest of its plugin and
configuration state.

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
