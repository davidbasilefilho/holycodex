# HolyCodex architecture

This document owns package placement and control/data flow. Observable
behavior belongs to [BEHAVIOR.md](BEHAVIOR.md), CLI wire details belong to
[CLI.md](CLI.md), security ownership belongs to [SECURITY.md](SECURITY.md),
and release evidence belongs to [PROVENANCE.md](PROVENANCE.md).

## Package graph

The public package is the only published package. Private workspace packages
are build inputs and must keep one-way dependencies.

```text
packages/cli ── core + codex + plugin
packages/codex ── core
packages/plugin ── core
packages/agent ── core
```

`core` owns immutable domain values, Effect Schema boundary schemas, errors,
plan names, route policy, capability metadata, and identity encodings.
`codex` owns the typed boundary to Codex native plugin management and native
subagent operations. `plugin` owns independently authored installed assets and
their manifests. `cli` composes installation, removal, configuration, version,
and presentation into the published Bun ESM artifact. The `agent` package owns
the deterministic model-facing Intent/Plan/Assignment command surface.

The native runtime has one parent and eleven leaves. Root is the parent Codex
session configured in `config.toml`. Each canonical `{Role}.{task}` leaf has
one managed TOML under `holycodex/agents/` and one matching
`agents."{Role}.{task}"` registration. A role-only file or registration is
legacy state, not a second supported model.

## Ownership and interfaces

| Concern                                 | Owner          | Stable interface                       |
| --------------------------------------- | -------------- | -------------------------------------- |
| Domain, plans, routes, and identities   | `core`         | Effect Schema values and typed records |
| Codex installation and native subagents | `codex`        | validated native Codex ports           |
| Installed agent assets                  | `plugin`       | generated immutable payload            |
| Commands and installation configuration | `cli`          | public human CLI and envelopes         |
| Intent, Plan, and Assignment state      | `agent`/`core` | semantic agent CLI / domain + store    |

Only the owning package decides its concern. Callers consume explicit exports;
cross-package filesystem imports and cycles are invalid. Every external,
persisted, CLI, Codex, and specialist value is validated at its receiving
boundary. I/O stays in the package that owns it.

## Control and data flow

```text
CLI input
   │
   ▼
Effect Schema validation → Root policy and scope decision
   │                         │
   │                         └─ denied → structured failure, no effect
   ▼
validated plan, tier, optional selections, and repo-local Intent
   │
   ▼
Codex native plugin management → native subagent assets and readback
   │
   ▼
Root creates bounded Assignments → native specialists return evidence
   │
   ▼
Root integrates, performs VCS, delegates exact-ref terminal CI/release checks
→ validated CLI/state response
```

Plans select native routing only. Service tiers are independent settings and
must not rewrite route policy or authority. Optional Work, frontend,
Security, and Computer Use selections are explicit and independently denied
when unavailable. Native subagents receive bounded Assignments; Root retains
scope, policy, material choices, lifecycle, integration, VCS, and final
judgment. Root MUST delegate every task, including trivial work. The only
direct Root execution exceptions are Git/VCS and Computer Use when selected at
installation. The typed orchestration policy in `core` is machine-testable.
After implementation or a major codebase change, `Reviewer.code` must reach a
fixed point before completion or any VCS operation. Root requests user input
before plan approval, remote/origin/server VCS mutations, or when material
ambiguity blocks safe progress.

Repo-local work state is separate from Codex-home installation state. The
`agent` CLI persists ignored `.holycodex/{slug}-{short-id}/` Intent, optional
Plan revisions, and Assignment files through semantic operations. Handoff is a
redacted projection of this state, never another source of truth.

Role profiles carry semantic authority and native capability controls. Task
skills carry branch-specific workflow, and delegation prompts carry only the
facts of one Assignment. The surgical-mutation rule in `AGENTS.md` is the
single instruction-level source for write minimization; Root and every
write-capable profile/skill receive that rule as a projection, without weaker
variants. The typed `core` export is the runtime projection used to generate
those instructions. This keeps each semantic instruction in one layer.

Installation preflights selected capabilities and runtime compatibility, then
journals native mutations and verifies readback before publishing managed
state. A retry reconciles an incomplete transaction. Installation changes only
the declared HolyCodex-owned configuration and the Codex native plugin state
required by that installation. Removal verifies ownership before deleting the
same scope. Neither command rewrites unrelated Codex settings or installs an
unrequested capability.

## Repository shape and checks

Keep tests beside the package seam they prove. Use Bun and `mise` for the
toolchain and `bun:test` for tests; OXC owns formatting and linting, while
TypeScript owns typechecking, and TypeScript remains strict.
Use no reverse imports, ownership-hiding compatibility layers, or duplicate
policy implementations. Add SPDX `Apache-2.0` headers to authored code;
Markdown remains unheaded. Inspect the final diff and run checks appropriate to
the changed seam before handoff.
