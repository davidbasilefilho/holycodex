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
tier, live web search, workspace-write command network access, compact
`developer_instructions`, required feature flags, and every
canonical `agents."{Role}.{task}".config_file` registration into
`<CODEX_HOME>/config.toml`. It also sets
`agents.max_concurrent_threads_per_session = 21` for every profile. Root is the
parent session in that file; no `agents/root.toml` is generated or registered.
Leaf TOMLs live under
`<CODEX_HOME>/holycodex/agents/<generation>/` and use native controls for their model,
reasoning effort, service tier, sandbox, approval, network, and delegation
features. Task permissions are specific: observational `Worker.operations` has
exact-ref/SHA network access without repository/source mutation;
`Worker.validation` may
write caches, build output, and generated test state while retaining no
authority to change the implementation under validation; and
`Worker.debugging` is the bounded repair route. Every generated specialist has
live web search and command network access. Task-specific sandbox modes are read-only or workspace-write. Writable leaves
set `sandbox_workspace_write.network_access = true`; task instructions and
`sourceMutation = false` preserve proof-only source boundaries. Generated leaves do not set
`tool_output_token_limit`.

These are HolyCodex configuration defaults. A stricter active session or
composer sandbox, managed policy, or unavailable web-search capability can
still block network use; generated configuration cannot widen those boundaries.

The concrete `Role.task` policy is the authority source. A task skill supplies
branch-specific workflow, while a delegation prompt supplies assignment facts.
Runtime flags enforce hard capability boundaries where Codex supports them;
prose does not stand in for a missing native control.

Root uses `gpt-6.1-sol` at low, medium, and high reasoning effort for the
`low`, `default`, and `high` profiles respectively; native specialist route
files use `gpt-6-luna`. Root dispatches the exact registered
concrete `Role.task` selected from the canonical route inventory. The role
families Explorer, Librarian, Worker, and Reviewer are labels only, and generic
built-in `worker`, `explorer`, `reviewer`, and `librarian` types are forbidden
for HolyCodex specialist Assignments.

HolyCodex manages
`features.context_management.experimental_mode = true` for Root and every
generated leaf. Removal restores the recorded prior value when unchanged, while
a user edit is preserved and reported as drift. Intent, Plan, and Assignment
persistence remains independent repo-local work state.

Root delegates implementation and observation through bounded Assignments,
unless the user explicitly requests direct execution. Git/VCS writes, shared
background server management, and visual judgment remain Root-owned. Ordinary
browser and computer work is delegated; visual tasks use Root-only visual-loop.
Root's visual fallback is generated from selected capabilities: Browser Use
adds IAB first; Computer Use follows when selected, then other available
rendered evidence. With only Computer Use selected, it comes first.
Reviewer.code reaches a fixed point before acceptance or VCS writes. Relevant
validation may run concurrently on non-conflicting scopes and reuse current
worker proof. There is no automatic planning or Plan approval workflow. Root
asks only for material missing information or missing authorization; existing
authorization is retained.

## Profiles, tiers, and optional plugins

The profile catalog owns valid product profile names and native routes. A
profile controls routing only. It selects configured Root and specialist route
identities and the task effort matrix owned by [BEHAVIOR.md](BEHAVIOR.md). The
generated instructions for every route target GPT-6-family behavior regardless
of a temporary routing model ID. A profile does not select a service tier or
grant authority.

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

Frontend and Security are required. Optional selections are explicit booleans
for `sites`, `browser_use`, and `computer_use`. On a first install, Sites and
Browser Use default to true while Computer Use defaults to false; omitted
selections otherwise inherit existing managed options. Sites availability can
depend on account, region, workspace policy, or supported Codex surface.
Browser Use depends on Codex surface/runtime. Computer Use has stronger
platform and surface restrictions and greater external-action capability.
Availability never grants authority. Unsupported or unavailable selected
capabilities and additional plugins fail explicitly; no silent omission or
substitute is accepted. Capability discovery resolves only providers needed
for the selected set; an unrelated unavailable provider does not abort the
install. Official `openai-curated` and `openai-curated-remote` identities are
equivalent only for allowlisted build-web-apps and codex-security plugins.
Bundled Browser, Computer Use, and Sites use their canonical
`openai-bundled` identities. A same-name third-party marketplace is not
trusted.

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
