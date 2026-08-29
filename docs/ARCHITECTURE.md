# HolyCodex architecture

This document owns package placement and control/data flow. Observable
behavior belongs to [BEHAVIOR.md](BEHAVIOR.md); CLI wire details belong to
[CLI.md](CLI.md); security ownership belongs to [SECURITY.md](SECURITY.md).
The graph is the implemented package shape. A change may combine packages
only when it preserves these owners, interfaces, and dependency directions.

## Package graph

The arrows point from importer to imported package. No package below may
import an app, and no package may create a cycle.

```text
packages/core
├── packages/codex
├── packages/workflow-runtime
├── packages/plugin
└── packages/workflow-host ── codex + workflow-runtime
                               │
                               ▼
                         packages/cli
```

`core` owns side-effect-free domain values, Effect Schema boundary schemas, IDs,
errors, the plan catalog, the declarative role/task registry, route policy,
limits, and identity encodings. Runtime role/task schemas, route keys,
capability metadata, assignment defaults, skill applicability, and permissions
derive from that registry.
`codex` owns App Server transport, exact-binary capability validation,
project/trust identity, Codex configuration ownership, and official-plugin
verification. `workflow-runtime` owns the production capability-denied QuickJS
TypeScript evaluator, its inert workflow API, Effect service boundaries, and
deterministic four-primitive mechanics; it owns no routing or host policy. `workflow-host`
owns orchestration, plan enforcement, journals, checkpoints, replay, retained
specialists, continuation, refinements, and sanitized telemetry. `plugin` is
private source and generation for independently authored installed assets.
`cli` is the only published package and composes installation, doctor,
cleanup, workflow commands, and output formatting. Its public package points
to one bundled Bun ESM artifact at `packages/cli/dist/index.js`; private
workspace packages are build-time inputs, not published workspace runtime
dependencies.

## Ownership and interfaces

| Concern                                 | Owner              | Stable interface                                 |
| --------------------------------------- | ------------------ | ------------------------------------------------ |
| Domain, catalog, identities             | `core`             | Effect Schema schemas and immutable typed values |
| Codex transport and trust               | `codex`            | validated App Server and configuration ports     |
| Untrusted workflow evaluation           | `workflow-runtime` | subprocess protocol and inert capability calls   |
| Orchestration and durable state         | `workflow-host`    | plan-enforced run lifecycle                      |
| Installed Codex assets                  | `plugin`           | generated immutable payload                      |
| Install/doctor/cleanup and presentation | `cli`              | user-facing commands and envelopes               |

Only the owning package decides its concern. Callers consume explicit public
exports and structured results; cross-package filesystem imports and cycles
are invalid. A type that crosses a package or process boundary is validated at
the receiving edge. I/O remains in `codex`, `workflow-host`, and `cli`.

## Control and data flow

```text
CLI or App Server request
        |
        v
Effect Schema boundary validation -> Root scope/policy decision
        |                              |
        |                              +-- denied -> structured failure, no effect
        v
plan and task-slot route -> bounded specialist assignment
        |                              |
        |                              v
        |                       structured specialist outcome
        |                              |
        +------------------------------v
                 Root integration and final judgment
                         |
           pre-effect approval -> authorized typed port
                         |
        journal intent -> Bun runtime/installer -> journal result
                         |
                  checkpoint and sanitized telemetry
                         |
                  validated CLI/App Server response
```

The workflow host records the accepted operation before a consequential effect,
records the result after the port returns, and checkpoints at a resumable
boundary. If the result cannot be classified, policy stops the workflow and
state preserves the uncertainty. Replay reads state projections only; it does
not re-enter effect ports. Resume reconstructs from the last valid checkpoint
and uncommitted journal tail without repeating committed effects. These are
observable rules owned by [BEHAVIOR.md](BEHAVIOR.md), while this diagram owns
their package placement.

`workflow-host` is the compatibility normalization boundary: it reads existing
payload and nested `options` values, combines run constraints, de-duplicates
lists, and emits one semantic assignment packet. The packet contains only the
assignment identity, objective, catalog authority, scope, references,
constraints, required evidence, acceptance, exclusions, escalation, and
optional delta, alongside validated route, tool, security, and compatibility
policy objects. `codex` owns the sole assignment compiler and renders only
those semantic fields plus role/task, the outcome protocol, and the
structural-leaf boundary. Host state and raw payload are not rendered. The
specialist result returns through the validated outcome boundary; deterministic
completion and retry eligibility remain runtime-owned.

Delegation mode is a core-owned enum and a workflow-host admission fact. Core
owns the exact wire values; workflow-host derives native cardinality from the
compiled plan, normalizes legacy compatibility callers at creation, persists
the mode in the workflow descriptor, and reuses that descriptor on inspection
and resume. Derived runs without descriptors remain mode-unspecified.

`workflow-runtime` owns declarative writer scopes because it owns graph
layering. It rejects overlapping file or symbol ownership in one parallel
layer; `workflow-host` therefore receives only plans whose writers are already
serialized or disjoint.

## Repository shape and checks

Keep each package cohesive, with tests beside the package seam they prove.
Use Bun and `mise` for runtime and tool selection, Vite+ for project tooling,
and TypeScript 7 for implementation. Use no reverse imports, compatibility
shims that hide ownership, or duplicate policy implementations. Add SPDX
`Apache-2.0` headers to authored code; Markdown remains unheaded. Before a
change is complete, run checks appropriate to its seam and inspect the final
diff; use [PROVENANCE.md](PROVENANCE.md) when a design claim needs evidence.
