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

`Worker.validation` runs the smallest relevant local checks for a delegated
seam, including builds, caches, generated test state, and other workspace
proof work when needed. It may write that generated or cached state, but it
cannot change the implementation under validation, redesign the solution, or
replace required code review. `Worker.debugging` reproduces a defect, captures
the evidence-backed root cause, makes the narrow repair, and proves the
regression is gone; material redesign returns to Root.

The native specialist inventory is fixed. Each identity below has one
HolyCodex-owned TOML at `<CODEX_HOME>/holycodex/agents/<Role.task>.toml` and
one Codex registration at `agents."<Role.task>"` in `config.toml`:

| Canonical identity      | Capability boundary                                    |
| ----------------------- | ------------------------------------------------------ |
| `Explorer.map`          | Read-only repository structure mapping                 |
| `Explorer.lookup`       | Read-only repository fact finding                      |
| `Explorer.trace`        | Read-only repository path tracing                      |
| `Librarian.lookup`      | Current-fact lookup with no repository mutation        |
| `Librarian.research`    | Current sourced research with no repository mutation   |
| `Worker.mechanical`     | Bounded deterministic implementation                   |
| `Worker.implementation` | Bounded behavior implementation                        |
| `Worker.integration`    | Bounded seam integration                               |
| `Worker.operations`     | Exact-ref/SHA-bounded CI or release observation        |
| `Worker.validation`     | Local behavioral proof with no implementation mutation |
| `Worker.debugging`      | Reproducible defect repair and regression proof        |
| `Reviewer.plan`         | Bounded plan inspection                                |
| `Reviewer.code`         | Bounded code inspection and repair                     |
| `Reviewer.artifact`     | Bounded artifact inspection and repair                 |

The canonical identity is `{Role}.{task}` throughout domain values, files,
registrations, installation ownership, migration, removal, and diagnostics.
Root is the parent Codex session configured in `config.toml`; it is never a
spawnable leaf and HolyCodex never creates or registers `agents/root.toml`.
The concrete `Role.task` policy owns authority and capability boundaries; the
task skill owns branch-specific procedure; a delegation prompt supplies
assignment facts.
Native leaf profiles disable delegation features, so leaves do not spawn or
message peers.

The Root orchestration contract requires normal specialist spawns to pass the
explicit `fork_turns = "none"` value and the exact registered `Role.task`
identity. Role families are labels only. Root gives the user only useful or
important information: it does not output after every tool use or subagent
update, emit routine status-only chatter or heartbeat messages, or follow a
fixed update cadence. Material updates include significant findings or
decisions, consequential blockers or input needs, and release milestones.
Native Astra Default questions remain available, including while independent
work proceeds. Root waits for terminal outcomes when no such update or question
is needed and sends out-of-boundary work back as a new bounded Assignment. For
every routine wait, Root uses `collaboration.wait_agent` with
`timeout_ms = 1200000` (20 minutes, within the cache lifetime); early specialist
completion wakes the wait and the collective mailbox already contains the
relevant agents. If that wait expires while idle, Root waits again with the same
timeout. Short waits, status or list polling, and message loops on idle timeout
are not routine coordination.
Specialist and Reviewer terminal reports are concise, structured, and
evidence-first: changed paths, checks, observable evidence, blockers, Root
decisions needed, and remaining risk. Root reads large transcripts or
artifacts only for material decisions, conflicts, failures, or findings;
stable facts are reused and each meaning has one authoritative owner. Stable
bounded component scopes are canonical ownership boundaries. The lifecycle
worker owns deterministic Intent, Plan, and Assignment API decisions; Root
retains material decisions, integration, and completion.
Root's managed configuration enables
`multi_agent = true`, disables `multi_agent_v2`, and enables
`context_management`; generated leaves set `agents.enabled = false`,
`multi_agent = false`, `multi_agent_v2 = false`, and
`context_management = true`. Generated configuration and readback tests prove
this V1 arrangement only; session metadata reports V2, so HolyCodex does not
claim live V1 runtime proof or owned fork enforcement.

Root uses `gpt-6-sol` for low/default and `gpt-6-astra` for high; every native specialist route uses `gpt-6-luna` with the effort matrix below. These are
routing identities; live skills and generated instructions target GPT-6-family
behavior. Root dispatches the exact registered concrete `Role.task` identity
selected from this inventory. Explorer, Librarian, Worker, and Reviewer are
role-family labels only; generic built-in `worker`, `explorer`, `reviewer`, and
`librarian` agent types are forbidden for HolyCodex specialist Assignments.

Root uses `request_user_input` only when fresh information or approval is
genuinely required, including a material scope or product choice or an
externally consequential, destructive, or remote effect. Root MUST orchestrate
and delegate every task, including trivial work, through a bounded Assignment
and native specialist. Root never performs implementation, testing, review,
research, or CI operations locally. The only direct Root execution exceptions
are Git/VCS and Computer Use when `--computer-use` was selected at
installation. Root still owns lifecycle, material decisions, integration
acceptance, and completion.

After integration, Root performs the approved VCS action, delegates
exact-ref/SHA terminal development CI observation to `Worker.operations`, and
delegates fixes for failures. Repeat until the repository's discovered gate is
terminal green; pending is never success. If release is authorized, Root uses
the repository's own release mechanism only after terminal development green,
then delegates terminal release verification and repeats bounded repair for
any failure. Discover whether the repository has separate development and
release gates, one pipeline, or no formal separation; do not assume GitHub or
a branch topology. With one or no distinct release gate, record that topology
and use only the repository's available terminal evidence.

Root uses `request_user_input` before seeking workflow Plan approval, before
installation profile approval, before any remote/origin/server VCS mutation or
public publication/release, and whenever ambiguity or missing material input
blocks safe progress; persist the resulting `needs_root_input` state on the
Intent or Plan. A passing `Reviewer.code` fixed-point review is mandatory after
implementation or a major codebase change and before completion or any VCS
operation.

The canonical core `SURGICAL_MUTATION_RULE` is the single instruction-level
source for source-mutating specialist tasks: make the smallest complete edit
set within the authorized boundary, preserve unrelated work, and stop for Root
input before expanding scope. Generated role profiles project that rule only
for source-mutating tasks; task skills supply procedure. Read-only and
observational tasks receive a literal no-source-mutation boundary.

## Profiles and tiers

The product profile catalog controls routing only. The live profiles are
`low`, `default`, and `high`; `default` is recommended. Every profile keeps
the native multi-agent surface and selects configured Root and specialist
route identities with this reasoning-effort matrix:

| Route                 | `low`  | `default` | `high` |
| --------------------- | ------ | --------- | ------ |
| Root model            | Sol    | Sol       | Astra  |
| Root/session agent    | medium | high      | high   |
| Specialist model      | Luna   | Luna      | Luna   |
| Explorer.map          | medium | high      | high   |
| Explorer.lookup       | medium | medium    | medium |
| Explorer.trace        | high   | xhigh     | max    |
| Librarian.lookup      | medium | medium    | medium |
| Librarian.research    | high   | xhigh     | max    |
| Worker.mechanical     | high   | high      | xhigh  |
| Worker.implementation | high   | xhigh     | max    |
| Worker.integration    | max    | max       | max    |
| Worker.operations     | high   | high      | xhigh  |
| Worker.validation     | medium | high      | xhigh  |
| Worker.debugging      | high   | xhigh     | max    |
| Reviewer.plan         | high   | xhigh     | max    |
| Reviewer.code         | max    | max       | max    |
| Reviewer.artifact     | high   | xhigh     | max    |

The Root/session route has no `xhigh` or `max` effort. All live skills and
generated Root, specialist, and Role.task instructions target GPT-6-family
behavior. Temporary routing model IDs are an independent implementation
setting and do not create a compatibility instruction layer. Historical route
values and the removed Go product value may appear only in narrowly scoped
migration, rollback, or cleanup handling for previously managed state. Legacy serialized `plan`
fields migrate losslessly to `profile`; `plus-low`, `plus`, and `plus-high`
migrate to `low`, `default`, and `high`. Legacy `go` and removed `pro-5x` or
`pro-20x` values are rejected with an explicit replacement requirement and are
never silently mapped to another profile.

The service tier is selected independently. It changes service handling only;
it does not change the profile, route, authority, trust boundary, or required
proof. The valid tier names are `standard`, `fast`, and `fast-all`. A missing
required capability or contradictory material evidence returns a structured
denial to Root and is never treated as success.

## Native capabilities

Coding and repository work use Bun, TypeScript, and the repository's typed
boundaries. Effect Schema from `effect/Schema` validates every external,
persisted, CLI, Codex, and specialist value before business logic sees it.

Optional frontend, Security, and Computer Use plugins are independently
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
frontend and Security; Computer Use is disabled unless selected.
GUI, browser, and Computer Use are Root/session-only. When Computer Use is
selected, Root may execute it directly; otherwise it is unavailable and is
never represented as delegateable work or a delegation fallback. No
unapproved fallback is installed or used.

Frontend selection adds workflow behavior. The core capability registry maps a
new visually-driven UI or meaningful redesign to
`build-web-apps:frontend-app-builder`, a rendered UI or interaction defect to
`build-web-apps:frontend-testing-debugging`, and a relevant React or Next
implementation or review to `build-web-apps:react-best-practices`. Repository
stack, existing design system, and explicit user requirements govern over
generic plugin defaults. Specialists inspect, implement, and repair. Root
renders, opens, and interacts with the current result, delegates concrete
discrepancies, and repeats until it accepts the requested result. Any source
change invalidates earlier render evidence. Logic-only changes do not require
visual ceremony.

Security selection adds proportional gates. Changes to trust boundaries,
authentication, authorization, privileged actions, sensitive-data flow,
external integrations, process/sandbox boundaries, or exposed surfaces use a
threat model. Security-sensitive diffs require a security diff scan before
VCS. A full scan is reserved for explicit audits, substantial exposed
surfaces, or systemic concern. Security repairs invalidate prior code review,
and code-review repairs to security-sensitive code invalidate prior security
evidence; both gates repeat until green together. A validated vulnerability
introduced or worsened by the change blocks VCS and release until repaired or
the user accepts the risk.

Librarian routes use Context7 first for current library, framework, SDK, API,
CLI, and cloud-service facts. They resolve the library identity, query narrowly,
and return `used`, `no_coverage`, `unavailable`, `auth_or_quota_failure`, or
`source_conflict` with evidence. Fallback requires one of those states or the
absence of the required version; authoritative first-party documentation wins
conflicts. A Librarian Assignment whose own contract names a non-historical
technical subject must include that typed Context7 evidence when its result is
received; unrelated external fact lookups and non-Librarian Assignments do not
inherit that requirement. Root retains material decisions.

## Intent work state

Intent, optional Plan, and bounded Assignments are persisted in ignored
repo-local `.holycodex/` state. The semantic `holycodex-agent` CLI validates
every request and persisted value, enforces lifecycle/readiness/completion,
archives old plans atomically, and records compact specialist outcomes and
evidence. Agents do not manually edit TOON. A handoff is only a redacted
projection of current state.

## Installation state

`install` preflights the selected capabilities, required providers, and runtime
compatibility before mutation. It then applies the selected profile, tier, and
optional plugins through Codex native plugin management, records progress in a
recoverable transaction, verifies the resulting state, and atomically records
the HolyCodex-owned configuration. An unrelated or unavailable provider is not
required by the selection and cannot abort an otherwise valid install.
Retries reconcile an active or incomplete transaction before publishing a new
state. `remove` verifies ownership and removes that configuration and the
corresponding native HolyCodex plugin state without touching unrelated Codex
state.

`doctor` compares effective `config.toml`, all canonical registrations
and files, selected capability health, ownership, stale HolyCodex legacy Root
files, and any preparing or conflicted transaction. It reports the observed
official plugin identity and actionable drift details rather than treating an
allowlisted equivalent as missing.

Both commands are explicit, bounded mutations. Invalid input, missing
permission, an unavailable required capability, failed verification, or
uncertain external state produces a structured failure and does not claim
success.

HolyCodex manages the canonical scalar `features.context_management` and sets
it to `true` for Root and every generated leaf because Codex does not
enable it by default. The package migration converts
owned historical `features.context_management.experimental_mode` state to the
scalar key, retaining unrelated settings only when the ownership evidence is
safe. The normal managed-key ownership rules preserve user edits and restore
the recorded prior value during cleanup; a user edit is preserved as drift. Repo-local Intent, workflow
Plan, and Assignment state remain independent of context management.

## Acceptance and provenance

An implementation is behaviorally complete when Root authority, native role
types, route-only profiles, independent tiers, optional capability denial,
installation ownership, secret exclusions, and fail-closed results are
observable and unambiguous. Each claim must have one owner and trace to the
evidence limits in [PROVENANCE.md](PROVENANCE.md).
