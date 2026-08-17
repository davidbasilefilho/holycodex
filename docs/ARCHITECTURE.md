# HolyCodex architecture

This document owns package placement and control/data flow. Observable
behavior belongs to [BEHAVIOR.md](BEHAVIOR.md); CLI wire details belong to
[CLI.md](CLI.md); security ownership belongs to [SECURITY.md](SECURITY.md).
The graph is an intended foundation for an empty repository, so an
implementation may combine packages only when it preserves these owners,
interfaces, and dependency directions.

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

`core` owns side-effect-free domain values, ArkType boundary schemas, IDs,
errors, the plan catalog, route policy, limits, and identity encodings.
`codex` owns App Server transport, exact-binary capability validation,
project/trust identity, Codex configuration ownership, and official-plugin
verification. `workflow-runtime` owns the isolated TypeScript evaluator and
its inert workflow API; it owns no routing or host policy. `workflow-host`
owns orchestration, plan enforcement, journals, checkpoints, replay, retained
specialists, continuation, refinements, and sanitized telemetry. `plugin` is
private source and generation for independently authored installed assets.
`cli` is the only published package and composes installation, doctor,
cleanup, workflow commands, and output formatting. Its public package points
to one bundled Bun ESM artifact at `packages/cli/dist/index.js`; private
workspace packages are build-time inputs, not published workspace runtime
dependencies.

## Ownership and interfaces

| Concern                                 | Owner              | Stable interface                               |
| --------------------------------------- | ------------------ | ---------------------------------------------- |
| Domain, catalog, identities             | `core`             | ArkType schemas and immutable typed values     |
| Codex transport and trust               | `codex`            | validated App Server and configuration ports   |
| Untrusted workflow evaluation           | `workflow-runtime` | subprocess protocol and inert capability calls |
| Orchestration and durable state         | `workflow-host`    | plan-enforced run lifecycle                    |
| Installed Codex assets                  | `plugin`           | generated immutable payload                    |
| Install/doctor/cleanup and presentation | `cli`              | user-facing commands and envelopes             |

Only the owning package decides its concern. Callers consume explicit public
exports and structured results; cross-package filesystem imports and cycles
are invalid. A type that crosses a package or process boundary is validated at
the receiving edge. I/O remains in `codex`, `workflow-host`, and `cli`.

## Control and data flow

```text
CLI or App Server request
        |
        v
ArkType boundary validation -> Root scope/policy decision
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
                 authorized effect through typed port
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

## Repository shape and checks

Keep each package cohesive, with tests beside the package seam they prove.
Use Bun and `mise` for runtime and tool selection, Vite+ for project tooling,
and TypeScript 7 for implementation. Use no reverse imports, compatibility
shims that hide ownership, or duplicate policy implementations. Add SPDX
`Apache-2.0` headers to authored code; Markdown remains unheaded. Before a
change is complete, run checks appropriate to its seam and inspect the final
diff; use [PROVENANCE.md](PROVENANCE.md) when a design claim needs evidence.
