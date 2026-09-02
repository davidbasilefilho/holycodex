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
```

`core` owns immutable domain values, Effect Schema boundary schemas, errors,
plan names, route policy, capability metadata, and identity encodings.
`codex` owns the typed boundary to Codex native plugin management and native
subagent operations. `plugin` owns independently authored installed assets and
their manifests. `cli` composes installation, removal, configuration, version,
and presentation into the published Bun ESM artifact.

## Ownership and interfaces

| Concern                                 | Owner    | Stable interface                       |
| --------------------------------------- | -------- | -------------------------------------- |
| Domain, plans, routes, and identities   | `core`   | Effect Schema values and typed records |
| Codex installation and native subagents | `codex`  | validated native Codex ports           |
| Installed agent assets                  | `plugin` | generated immutable payload            |
| Commands and configuration              | `cli`    | user-facing commands and envelopes     |

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
validated plan, tier, and optional selections
   │
   ▼
Codex native plugin management → native subagent assets and readback
   │
   ▼
atomic HolyCodex configuration → validated CLI response
```

Plans select native routing only. Service tiers are independent settings and
must not rewrite route policy or authority. Optional Work, frontend,
Security, and Computer Use selections are explicit and independently denied
when unavailable. Native subagents receive bounded assignments; Root retains
scope, policy, integration, and final judgment.

Installation changes only the declared HolyCodex-owned configuration and the
Codex native plugin state required by that installation. Removal verifies
ownership before deleting the same scope. Neither command rewrites unrelated
Codex settings or installs an unrequested capability.

## Repository shape and checks

Keep tests beside the package seam they prove. Use Bun and `mise` for the
pinned toolchain, Vite+ for project checks, and TypeScript 7 for implementation.
Use no reverse imports, ownership-hiding compatibility layers, or duplicate
policy implementations. Add SPDX `Apache-2.0` headers to authored code;
Markdown remains unheaded. Inspect the final diff and run checks appropriate to
the changed seam before handoff.
