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
errors, the plan catalog, route policy, limits, and identity encodings.
`codex` owns App Server transport, exact-binary capability validation,
project/trust identity, Codex configuration ownership, and official-plugin
verification. `workflow-runtime` owns the production Effect workflow runtime,
the isolated TypeScript evaluator, its inert workflow API, and the explicit
QuickJS compatibility evaluator; it owns no routing or host policy. `workflow-host`
owns orchestration, plan enforcement, journals, checkpoints, replay, retained
specialists, continuation, refinements, and sanitized telemetry. `plugin` is
private source and generation for independently authored installed assets.
`cli` is the only published package and composes installation, doctor,
cleanup, workflow commands, session workflow-file ownership, and output
formatting. The published package exposes the executable/root bundle at
`packages/cli/dist/index.js` and the supported authoring surface at
`holycodex/workflow`; private workspace packages remain build-time inputs and
must not be imported by users.

## Ownership and interfaces

| Concern                                 | Owner              | Stable interface                                 |
| --------------------------------------- | ------------------ | ------------------------------------------------ |
| Domain, catalog, identities             | `core`             | Effect Schema schemas and immutable typed values |
| Codex transport and trust               | `codex`            | validated App Server and configuration ports     |
| Workflow DSL and Effect runtime         | `workflow-runtime` | internal implementation consumed through `holycodex/workflow` |
| Orchestration and durable run state     | `workflow-host`    | plan-enforced run lifecycle                      |
| Session workflow file ownership         | `cli`              | managed `.ts` identity/materialization boundary  |
| Installed Codex assets                  | `plugin`           | generated immutable payload                      |
| Install/doctor/cleanup and presentation | `cli`              | user-facing commands and envelopes               |

Only the owning package decides its concern. Callers consume explicit public
exports and structured results; cross-package filesystem imports and cycles
are invalid. A type that crosses a package or process boundary is validated at
the receiving edge. I/O remains in `codex`, `workflow-host`, and `cli`.

## Public workflow authoring boundary

Workflow authors import DSL primitives and author-facing codecs from
`holycodex/workflow`. That subpath is a deliberate compatibility boundary: it
re-exports only the supported authoring API from the private runtime package.
Documentation, examples, generated workflows, and package smoke tests must use
that public subpath. Direct imports of `@holycodex/workflow-runtime` are
workspace-internal and are not a supported user contract.

Native workflow examples are only considered valid when the packed package can
load them through the production CLI path and execute the resulting
`workflow.wait(...)` value. Workspace-only typechecking is insufficient proof.

## Session workflow-file architecture

Root-authored/generated workflows are source artifacts, not opaque JSON cache
entries. The CLI-owned state root materializes them at:

```text
~/.codex/holycodex/workflows/{sessionId}/{name}-{shortHash}.ts
```

The session directory provides ownership and collision isolation. `name` is a
purpose-derived filesystem-safe slug, while `shortHash` derives from a full
domain-separated content/identity digest. Identical workflow identity/content
therefore has a stable path where practical and revisions receive distinct
paths. The ordinary `.ts` file is the inspectable/debuggable source of truth.

The CLI owns path validation, no-symlink enforcement, deterministic naming,
atomic persistence, digest verification, tamper detection, and session cleanup.
The workflow host continues to own run identity and stores the workflow source
digest as part of that identity rather than embedding source text in durable run
state. Resume/replay/continuation recover or receive the owned source and must
verify it against that digest before effects.

Explicit `workflow save user|project` semantics remain separate persisted
features. Their JSON stores are not an implementation shortcut for ephemeral or
session-generated Root workflows.

## Control and data flow

```text
CLI or App Server request
        |
        v
Effect Schema boundary validation -> Root scope/policy decision
        |                              |
        |                              +-- denied -> structured failure, no effect
        v
materialize/verify owned workflow .ts when session-generated
        |
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

## Repository shape and checks

Keep each package cohesive, with tests beside the package seam they prove.
Use Bun and `mise` for runtime and tool selection, Vite+ for project tooling,
and TypeScript 7 for implementation. Use no reverse imports, compatibility
shims that hide ownership, or duplicate policy implementations. Add SPDX
`Apache-2.0` headers to authored code; Markdown remains unheaded. Before a
change is complete, run checks appropriate to its seam and inspect the final
diff; use [PROVENANCE.md](PROVENANCE.md) when a design claim needs evidence.
