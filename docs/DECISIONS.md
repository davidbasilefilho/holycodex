# Decisions

This register records durable choices. The owning contract remains the source
of truth for each behavior.

| ID     | Decision                                                                                  | Consequence                                                                               | Owner                                                                  |
| ------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `D-01` | The repository uses only admitted task, current-source, and repository-authored evidence. | Undocumented historical behavior is not a compatibility target.                           | [PROVENANCE.md](PROVENANCE.md)                                         |
| `D-02` | Effect Schema from `effect/Schema` is the sole boundary-validation ecosystem.             | Every external, persisted, CLI, Codex, and specialist value has one typed validator.      | [ARCHITECTURE.md](ARCHITECTURE.md), [DEPENDENCIES.md](DEPENDENCIES.md) |
| `D-03` | Native Codex plugin management owns plugin installation and native subagent execution.    | HolyCodex stores only its configuration and does not duplicate platform state.            | [INSTALLATION.md](INSTALLATION.md)                                     |
| `D-04` | Plans are routing-only; service tiers are independent.                                    | A plan cannot change service handling, authority, or proof requirements.                  | [BEHAVIOR.md](BEHAVIOR.md), [CONFIGURATION.md](CONFIGURATION.md)       |
| `D-05` | Root owns material choices and Workers implement mergeable bounded seams.                 | Leaf work returns evidence and escalates architecture, scope, risk, and external effects. | [BEHAVIOR.md](BEHAVIOR.md), [SECURITY.md](SECURITY.md)                 |
| `D-06` | Bun and `mise` are the local toolchain; Vite+ owns repository checks.                     | CI and repository proofs use one reproducible command path.                               | [DEVELOPMENT.md](DEVELOPMENT.md)                                       |
| `D-07` | The version script synchronizes the CLI and plugin manifests.                             | A release has one canonical version with two matching manifest copies.                    | [RELEASING.md](RELEASING.md)                                           |
| `D-08` | Release publication is configured, exact-artifact checked, and approval-gated.            | External publication requires matching source SHA, version, and artifact digest.          | [RELEASING.md](RELEASING.md)                                           |
| `D-09` | CI observation after an approved origin change is read-only and exact-ref/SHA bound.      | `Worker.operations` may report checks but cannot mutate external state.                   | [PARITY.md](PARITY.md), [SECURITY.md](SECURITY.md)                     |
