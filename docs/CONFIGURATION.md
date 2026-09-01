# Configuration

This document owns configuration precedence, plan and optional selections,
explicit paths, managed ownership, and compare-before-write behavior. Runtime
semantics remain in [BEHAVIOR.md](BEHAVIOR.md); CLI syntax and non-TTY rules
remain in [CLI.md](CLI.md); secret exclusions remain in [SECURITY.md](SECURITY.md).

## Precedence

The effective configuration is resolved in this order, from strongest to
weakest:

1. Explicit invocation input, including CLI flags and an approved caller
   override.
2. Workspace configuration for the current trusted project.
3. User configuration for the current account.
4. Safe built-in defaults.

Each layer is validated before it can override the next layer. A missing
required value, malformed value, or untrusted path fails closed. Specialists
receive a read-only effective snapshot and never write configuration.

The current installer exposes explicit plan, tier, optional-selection, and
root-path inputs. The environment supplies `CODEX_HOME` when no explicit path
is provided. The CLI adapter
does not turn arbitrary environment values into persisted configuration.

## Plan, tier, and optional selections

The plan catalog owns valid plan names, budgets, routes, and workflow
availability. `Go` is a direct Root path and is not admitted to the workflow
host. Workflow-enabled plans are selected by name and validated against the
catalog before use.

`Standard` is the default service tier. `Fast` changes service tier only; it
does not change model, authority, budget, routing, or proof requirements.

Optional selections are explicit booleans for `computer_use`, `work`, `web`,
and `security`; the `coding` capability is required and remains enabled. An
omitted optional value inherits the previous install record, then defaults to
disabled. A positive and negative flag for the same selection is invalid.
Capability availability never grants authority, and a denied capability is not
replaced by an unapproved fallback.

## Explicit paths and ownership

`CODEX_HOME` defaults to `~/.codex`. Use `--codex-home` for an explicit override
or isolated test. Paths must be absolute, traversal-free, and non-broad. The
installer owns only its state and generated `{Role}.{task}` agent profiles; it
uses Codex's official plugin and feature commands and does not rewrite unrelated
plugins, configuration fields, feature flags, or external servers. See
[INSTALLATION.md](INSTALLATION.md) for the path layout and transaction.

## Managed writes and compare-before-write

Configuration writes require a declared owner. The
managed configuration metadata carries owner, schema, and install identity.
Before a write, the owner compares the existing managed fields and refuses to
overwrite a changed or foreign value. A matching value is safe to retain; a
changed value is preserved for explicit resolution. Cleanup applies the same
ownership test before removing HolyCodex-owned state.

Atomic writes and journal records bracket consequential pointer changes. A
failed write rolls back bytes that were previously read when rollback is safe;
an uncertain result is preserved and reported. The installer never broadens a
write because a path is missing.

## Secrets

No secret belongs in configuration, an install record, a CLI envelope, a
journal, a checkpoint, or telemetry. This includes API keys, access tokens,
cookies, passwords, private keys, authorization headers, credential-bearing
URLs, raw environment values, and raw task or specialist content. The complete
exclusion and sanitization policy is owned by [SECURITY.md](SECURITY.md).
