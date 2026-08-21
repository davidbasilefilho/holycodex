# HolyCodex behavioral contract

This document is the single normative owner of observable runtime behavior.
It describes what a caller can observe, not how packages implement it. The
CLI wire format is owned by [CLI.md](CLI.md); package placement and flow are
owned by [ARCHITECTURE.md](ARCHITECTURE.md); security boundaries and recovery
are owned by [SECURITY.md](SECURITY.md); evidence limits are owned by
[PROVENANCE.md](PROVENANCE.md). Those documents link here instead of
repeating this contract.

## Authority and routing

Root is the authority for scope, architecture, product choices, policy,
material risk, integration, external state, and the final readiness judgment.
Root accepts specialist evidence, resolves contradictions, and decides
whether work is complete. A specialist may report facts, execute its bounded
assignment, or review its assigned surface; it may not broaden scope, invent a
material requirement, delegate, change Root's decision, or approve its own
unreviewed external effect.

The four capability specialists are fixed role contracts:

| Specialist | Capability                                                           | Authority boundary                                                                                                                                    |
| ---------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explorer   | Read-only repository mapping and local fact finding                  | Reads the permitted workspace and returns paths, symbols, callers, tests, and constraints; writes nothing.                                            |
| Librarian  | Assigned current-fact research                                       | Uses only the assigned official dossier and permitted current documentation route; returns sourced facts and uncertainty; makes no repository change. |
| Worker     | Bounded implementation, integration, checks, and approved operations | Changes only the assigned seam, runs proportional checks, repairs bounded defects, and returns structured evidence. Material choices return to Root.  |
| Reviewer   | Adversarial review and bounded repair                                | Inspects the assigned result to a fixed point, repairs only reviewer-owned defects within scope, and returns findings and proof.                      |

The eleven task slots are routing identifiers attached to one capability role,
not stages or additional authorities:

| Specialist | Task slots                                                  |
| ---------- | ----------------------------------------------------------- |
| Explorer   | `lookup`, `trace`                                           |
| Librarian  | `lookup`, `research`                                        |
| Worker     | `mechanical`, `implementation`, `integration`, `operations` |
| Reviewer   | `plan`, `code`, `artifact`                                  |

Root selects the specialist and slot from the outcome, evidence needed,
authority boundary, and completion criterion. One specialist may serve several
slots in sequence, but no slot creates a new authority or permits a specialist
to delegate.

## Effort and interaction values

The active plan owns the cost target, hard maximum, `maxCalls`,
`maxConcurrency`, and the route table. A higher value may increase bounded
evidence gathering only when the plan permits it; it never changes authority,
scope, trust boundaries, or completion criteria.

| Value       | Observable routing meaning                                        |
| ----------- | ----------------------------------------------------------------- |
| `Go`        | Root uses Terra high directly. Specialist workflows are disabled. |
| `plus-low`  | Sol low; cost target/max `1.0/1.5`, 10 calls, concurrency 3.      |
| `plus`      | Sol medium; cost target/max `1.6/2.5`, 16 calls, concurrency 3.   |
| `plus-high` | Sol high; cost target/max `3.0/4.5`, 24 calls, concurrency 4.     |
| `pro-5x`    | Sol high; cost target/max `5.0/7.5`, 40 calls, concurrency 6.     |
| `pro-20x`   | Sol xhigh; cost target/max `12.0/20.0`, 64 calls, concurrency 8.  |

Workflow specialists use Luna and the active plan's role-and-task-specific
effort. `Standard` is the default service tier. `Fast` changes service tier,
not model, reasoning effort, authority, budget, or required proof. A capability
denial or contradictory material evidence returns to Root; it is never silently
treated as success.

## Coding and TypeScript workflows

Coding is the default for repository implementation, fixes, tests, manifests,
and diagnostics. Code runs on Bun, is authored in current TypeScript 7, uses
Vite+ tooling, and uses Bun-native APIs where the platform provides them.
Effect Schema from `effect/Schema` validates every external, persisted, CLI, App
Server, and specialist boundary before business logic sees it. A workflow has
an explicit input, validated state transition, bounded effect,
journal/checkpoint decision, verification result, and terminal outcome.
Unvalidated JSON, `any`, and unjustified casts do not cross a boundary.

Native workflow-module execution is the production path. The CLI accepts a
trusted TypeScript file whose default export is a `workflow.wait(...)` value;
the runtime owns deterministic four-primitive mechanics, while Root performs
the pre-effect approval and final judgment. QuickJS is an explicit
compatibility-only evaluator selected by `--compat-quickjs`; stdin requires
that flag and an explicit task objective. The compatibility path does not
change native workflow policy.

Optional Context7, LSP, Git Bash, Computer Use, Work, Web, and Security
capabilities are independently deniable. Context7 is the first route for
current library, framework, SDK, and API documentation; Web is reserved for
releases, dates, broader research, missing coverage, or corroboration. LSP
supports type-aware repository work; Git Bash supports permitted shell
workflows; Computer Use supports approved interactive computer control; Work
and Web support their enabled product surfaces; Security supports authorized
security work. An unavailable capability produces a structured denial, and no
MCP server or plugin is installed as a fallback or as a side effect.

## App Server and state identity

Codex App Server is the supported programmatic bridge to managed Codex
threads. HolyCodex performs its initialization handshake, validates the
capabilities and response schemas exposed by the exact discovered Codex
binary, and uses only the required thread and turn methods. The local
0.148.0 generated artifact records stable multi-agent support, locally
disabled `multi_agent_v2`, and an unverified distinct V2 lifecycle. An
advertised V2 capability therefore fails closed; the stable App Server
fallback is the executable path. App Server cannot bypass Root routing,
inherited approval/sandbox policy, journals, checkpoints, telemetry, or
fail-closed rules.

Each execution has a stable `run_id` and an append-only journal. A checkpoint
is a validated, resumable projection tied to a journal position. Resume loads
the last valid checkpoint and journal tail, does not repeat a committed effect,
and fails closed when state or effect completion is uncertain. Replay projects
retained journal data without performing external effects and marks its output
as replayed. Retention is bounded by configuration and applies only to
HolyCodex-owned terminal state; active or integrity-uncertain state is not
silently removed. Cleanup follows the explicit command contract in
[CLI.md](CLI.md) and recovery rules in [SECURITY.md](SECURITY.md).

A continuation creates a new `run_id` with the same objective lineage and an
explicit parent identity. A refinement creates a new `run_id` and a new
refinement identity because its objective, constraints, or acceptance criteria
changed; it retains parent linkage for auditability. A crash resume retains the
run identity. Retries and idempotency keys never turn an uncertain effect into
an assumed success.

Telemetry is sanitized before emission. It may contain allowlisted run,
command, capability, duration, status, count, schema, and redacted error
metadata. It excludes secrets, credentials, tokens, private keys, cookies,
authorization headers, raw environment values, and raw task, file, prompt, or
specialist content. The complete exclusion and recovery policy is owned by
[SECURITY.md](SECURITY.md).

Install, doctor, cleanup, and `--json` are observable commands. Install is an
explicit, Bun-only, owned-scope mutation; doctor is read-only; cleanup acts
only on an explicitly selected owned scope; JSON mode emits one structured
envelope and never prompts. Their exact syntax, exit codes, and non-TTY rules
are frozen in [CLI.md](CLI.md).

## Configuration ownership

The policy layer owns configuration schemas, precedence, validation, and the
effective configuration snapshot. Root owns material configuration choices;
the CLI and App Server only submit explicit overrides and render results.
Precedence is explicit invocation input, then workspace configuration, then
user configuration, then safe built-in defaults. Invalid or missing required
configuration fails closed. Specialists receive a read-only effective
snapshot and cannot write configuration. Only an explicitly approved
installer operation may write HolyCodex-managed configuration, and it may not
turn an environment value into persisted secret material.

## Failure behavior

The system fails closed when an input is invalid, a capability is denied, a
trust boundary cannot be established, persisted state is corrupt or
ambiguous, a requested permission is absent, or an external effect cannot be
classified. It returns a structured failure with the stable operation and
error identity, preserves available journal evidence, and does not claim a
successful effect. Human output may improve presentation, but it cannot alter
the machine outcome.

## Acceptance and provenance

This foundation is accepted when all of the following hold:

- every externally visible rule has one owning document and cross-document
  links do not contradict it;
- all eleven slots and four specialist boundaries route to Root authority;
- effort values, Standard/Fast behavior, denial, fail-closed behavior, state
  identities, and sanitized telemetry are observable and unambiguous;
- CLI envelopes, exits, and non-TTY behavior are frozen in [CLI.md](CLI.md);
- package ownership and control/data flow are recorded in [ARCHITECTURE.md](ARCHITECTURE.md);
- isolation, installer, secret, and recovery constraints are recorded in
  [SECURITY.md](SECURITY.md); and
- every claimed fact is traceable to the ledger and limits in
  [PROVENANCE.md](PROVENANCE.md), with authored contract choices clearly
  distinguished from supplied facts.

The provenance ledger for this contract is:

| ID     | Evidence                                                                | Permitted use                                                                                                                                                |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `P-01` | This task specification                                                 | Project name/version, clean-room boundary, requested deliverables, role model, values, required capabilities, and completion checks explicitly stated there. |
| `P-02` | Supplied official current-source dossier                                | Current Codex, toolchain, dependency, and license facts stated in the dossier; no live-provider claim.                                                       |
| `P-03` | Local implementation, generated provenance, and repository-native proof | Implemented behavior and local validation evidence; not external availability, publication, or post-push CI.                                                 |
| `D-01` | Independent contract decisions in this document                         | New observable choices required to make the requested foundation coherent; they are not presented as historical or compatibility facts.                      |

The exact whitelist, boundary, and limitations are authoritative in
[PROVENANCE.md](PROVENANCE.md). No historical implementation input or copied
historical prose is part of this contract.
