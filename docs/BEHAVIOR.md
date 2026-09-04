# HolyCodex behavioral contract

This document owns observable behavior. CLI syntax and envelopes belong to
[CLI.md](CLI.md); package placement belongs to [ARCHITECTURE.md](ARCHITECTURE.md);
trust and recovery belong to [SECURITY.md](SECURITY.md); evidence limits belong
to [PROVENANCE.md](PROVENANCE.md).

## Authority and routing

Root owns user intent and scope, architecture, product choices, policy,
material risk, integration, external state and effects, contradictory-evidence
resolution, and final readiness. Root accepts specialist evidence and resolves
contradictions. Specialists execute literal bounded assignments and return
evidence for Root's judgment.

The native specialist inventory is fixed. Each identity below has one
HolyCodex-owned TOML at `<CODEX_HOME>/holycodex/agents/<Role.task>.toml` and
one Codex registration at `agents."<Role.task>"` in `config.toml`:

| Canonical identity      | Capability boundary                                  |
| ----------------------- | ---------------------------------------------------- |
| `Explorer.lookup`       | Read-only repository fact finding                    |
| `Explorer.trace`        | Read-only repository path tracing                    |
| `Librarian.lookup`      | Current-fact lookup with no repository mutation      |
| `Librarian.research`    | Current sourced research with no repository mutation |
| `Worker.mechanical`     | Bounded deterministic implementation                 |
| `Worker.implementation` | Bounded behavior implementation                      |
| `Worker.integration`    | Bounded seam integration                             |
| `Worker.operations`     | Approved, bounded observation                        |
| `Reviewer.plan`         | Bounded plan inspection                              |
| `Reviewer.code`         | Bounded code inspection and repair                   |
| `Reviewer.artifact`     | Bounded artifact inspection and repair               |

The canonical identity is `{Role}.{task}` throughout domain values, files,
registrations, installation ownership, migration, removal, and diagnostics.
Root is the parent Codex session configured in `config.toml`; it is never a
spawnable leaf and HolyCodex never creates or registers `agents/root.toml`.
The role profile owns authority and capability boundaries; the task skill owns
branch-specific procedure; a delegation prompt supplies assignment facts.
Native leaf profiles disable delegation features, so leaves do not spawn or
message peers.

Root proceeds autonomously with safe local inspection, implementation, and
proportional verification inside approved scope. Root uses `request_user_input`
only when fresh information or approval is genuinely required, including a
material scope or product choice or an externally consequential, destructive,
or remote effect. Git/VCS remains Root-only.

## Plans and tiers

The plan catalog controls routing only. `go` keeps Terra/high for Root and uses
the plus-low Luna leaf route matrix; the Plus and Pro plans select progressively
broader native specialist routes. A plan never grants authority, changes scope,
or supplies a completion decision.

The valid plan names are `go`, `plus-low`, `plus`, `plus-high`, `pro-5x`, and
`pro-20x`.

The service tier is selected independently. It changes service handling only;
it does not change the plan, route, authority, trust boundary, or required
proof. The valid tier names are `standard`, `fast`, and `fast-all`. A missing required capability or
contradictory material evidence returns a structured denial to Root and is
never treated as success.

## Native capabilities

Coding and repository work use Bun, TypeScript, and the repository's typed
boundaries. Effect Schema from `effect/Schema` validates every external,
persisted, CLI, Codex, and specialist value before business logic sees it.

Optional Work, frontend, Security, and Computer Use plugins are independently
selected. Selection does not claim availability or grant authority. Every
selected capability and additional plugin must be installed and enabled by
native plugin management. Official OpenAI curated identities are matched by
an allowlist: at minimum, `build-web-apps@openai-curated` and
`build-web-apps@openai-curated-remote`, and `codex-security@openai-curated` and
`codex-security@openai-curated-remote`, are equivalent official identities.
An arbitrary same-name plugin from another marketplace is not equivalent.
Doctor reports the observed official identity. If verification cannot confirm
the selected capability, installation fails with a classified denial or
integrity error and does not claim success. The default selections are
frontend and Security; Work and Computer Use are disabled unless selected.
No unapproved fallback is installed or used.

## Installation state

`install` preflights the selected capabilities, required providers, and runtime
compatibility before mutation. It then applies the selected plan, tier, and
optional plugins through Codex native plugin management, records progress in a
recoverable transaction, verifies the resulting state, and atomically records
the HolyCodex-owned configuration. An unrelated or unavailable provider is not
required by the selection and cannot abort an otherwise valid install.
Retries reconcile an active or incomplete transaction before publishing a new
state. `remove` verifies ownership and removes that configuration and the
corresponding native HolyCodex plugin state without touching unrelated Codex
state.

`doctor` compares effective `config.toml`, all eleven canonical registrations
and files, selected capability health, ownership, stale HolyCodex legacy Root
files, and any preparing or conflicted transaction. It reports the observed
official plugin identity and actionable drift details rather than treating an
allowlisted equivalent as missing.

Both commands are explicit, bounded mutations. Invalid input, missing
permission, an unavailable required capability, failed verification, or
uncertain external state produces a structured failure and does not claim
success.

## Acceptance and provenance

An implementation is behaviorally complete when Root authority, native role
types, route-only plans, independent tiers, optional capability denial,
installation ownership, secret exclusions, and fail-closed results are
observable and unambiguous. Each claim must have one owner and trace to the
evidence limits in [PROVENANCE.md](PROVENANCE.md).
