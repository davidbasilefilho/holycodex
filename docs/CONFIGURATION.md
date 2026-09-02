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

## Plans, tiers, and optional plugins

The plan catalog owns valid plan names and native routes. A plan controls
routing only. `Go` keeps Terra/high for Root and uses the plus-low Luna leaf
route matrix; Plus and Pro plans select specialist routes. A plan does not
select a service tier or grant authority.

The valid plan names are `Go`, `plus-low`, `plus`, `plus-high`, `pro-5x`, and
`pro-20x`.

The service tier is an independent setting selected with `--tier`. It changes
service handling without changing the plan, route, authority, or proof
requirements. The valid tier names are `standard`, `fast`, and `fast-all`.

Optional plugins are explicit booleans for `work`, `frontend`, `security`, and
`computer_use`. On a first install, Work and Computer Use default to false while
frontend and Security default to true; an omitted selection otherwise inherits
the existing managed configuration. Availability never grants authority.
Explicitly selected or additionally requested plugins return a structured
denial when missing. An unavailable implicit frontend or Security first-install
default is recorded as `missing` or `uncertain`, warned about, and retried on a
later reinstall; no fallback is selected.

## Paths and ownership

`CODEX_HOME` defaults to `~/.codex`; `--codex-home` supplies an absolute,
isolated test or user path. Paths are traversal-free and never broadened to a
workspace root. HolyCodex owns only its configuration and the native plugin
state created for that installation. Codex owns the rest of its plugin and
configuration state.

## Managed writes

Every managed write carries an owner, schema, install identity, and digest.
Before writing, the CLI compares existing managed fields and refuses to
overwrite a changed or foreign value. Matching state is retained. Writes are
atomic and validated before persistence; an uncertain result is preserved and
reported.

Removal applies the same ownership test and never deletes unrelated Codex
state.

## Secrets

No secret belongs in configuration, a CLI envelope, or diagnostic output. This
includes API keys, access tokens, cookies, passwords, private keys,
authorization headers, credential-bearing URLs, raw environment values, and
credential files. The complete policy is owned by [SECURITY.md](SECURITY.md).
