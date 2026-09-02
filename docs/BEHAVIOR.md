# HolyCodex behavioral contract

This document owns observable behavior. CLI syntax and envelopes belong to
[CLI.md](CLI.md); package placement belongs to [ARCHITECTURE.md](ARCHITECTURE.md);
trust and recovery belong to [SECURITY.md](SECURITY.md); evidence limits belong
to [PROVENANCE.md](PROVENANCE.md).

## Authority and routing

Root owns scope, architecture, product choices, policy, material risk,
integration, external state, and the final readiness judgment. Root accepts
specialist evidence and resolves contradictions. Specialists execute only
literal bounded assignments and cannot broaden scope, delegate, change Root's
decision, or approve an unreviewed external effect.

The native specialist roles are fixed:

| Specialist | Task slots                                                  | Boundary                                         |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Explorer   | `lookup`, `trace`                                           | Read-only repository mapping and fact finding    |
| Librarian  | `lookup`, `research`                                        | Assigned current-fact research                   |
| Worker     | `mechanical`, `implementation`, `integration`, `operations` | Bounded changes, checks, and approved operations |
| Reviewer   | `plan`, `code`, `artifact`                                  | Adversarial inspection and bounded repair        |

The canonical identity is `{Role}.{task}`. Root selects the native type from
the required outcome, evidence, authority boundary, and completion criterion.
The task name identifies one invocation and does not replace the canonical
type. Native subagents must preserve the assigned scope and return structured
evidence.

## Plans and tiers

The plan catalog controls routing only. `Go` keeps Terra/high for Root and uses
the plus-low Luna leaf route matrix; the Plus and Pro plans select progressively
broader native specialist routes. A plan never grants authority, changes scope,
or supplies a completion decision.

The valid plan names are `Go`, `plus-low`, `plus`, `plus-high`, `pro-5x`, and
`pro-20x`.

The service tier is selected independently. It changes service handling only;
it does not change the plan, route, authority, trust boundary, or required
proof. The valid tier names are `standard`, `fast`, and `fast-all`. A missing capability or
contradictory material evidence returns a structured denial to Root and is
never treated as success.

## Native capabilities

Coding and repository work use Bun, TypeScript, and the repository's typed
boundaries. Effect Schema from `effect/Schema` validates every external,
persisted, CLI, Codex, and specialist value before business logic sees it.

Optional Work, frontend, Security, and Computer Use plugins are independently
selected. Selection does not claim availability or grant authority. An
unavailable capability returns `capability_denied`; no unapproved fallback is
installed or used.

## Installation state

`install` validates the target, applies the selected plan, tier, and optional
plugins through Codex native plugin management, verifies the resulting state,
and atomically records the HolyCodex-owned configuration. `remove` verifies
ownership and removes that configuration and the corresponding native
HolyCodex plugin state without touching unrelated Codex state.

Both commands are explicit, bounded mutations. Invalid input, missing
permission, unavailable capability, failed verification, or uncertain external
state produces a structured failure and does not claim success.

## Acceptance and provenance

An implementation is behaviorally complete when Root authority, native role
types, route-only plans, independent tiers, optional capability denial,
installation ownership, secret exclusions, and fail-closed results are
observable and unambiguous. Each claim must have one owner and trace to the
evidence limits in [PROVENANCE.md](PROVENANCE.md).
