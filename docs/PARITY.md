# HolyCodex parity matrix

This matrix records the current baseline and independent proof for the
current surface. It is evidence, not the behavioral authority; current behavior
belongs to [BEHAVIOR.md](BEHAVIOR.md), package placement to
[ARCHITECTURE.md](ARCHITECTURE.md), CLI wire behavior to [CLI.md](CLI.md),
security to [SECURITY.md](SECURITY.md), release boundaries to
[RELEASING.md](RELEASING.md), and evidence limits to [PROVENANCE.md](PROVENANCE.md).

## Baseline and admissible difference

| Identity                         | Exact value                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Source baseline SHA              | `682adea6d6cba374251152af612489126e9c64c1`                                                                             |
| Frozen behavioral oracle SHA     | `eb796235f2f29f2c67c869408a0e22c1a72c13eb`                                                                             |
| Foundation version               | Canonical `version` in `packages/cli/package.json`                                                                     |
| Permitted operational difference | `Worker.operations` observes CI after an approved origin change from the exact ref and SHA, without mutation authority |

`proven` means repository-native proof exists. `capability-gated` means the
selection and denial path is proven locally while live provider availability is
not claimed. `external pending` is reserved for approved remote actions and
their readback.

## Required surface inventory

| Surface                                                                 | Owner                                                                  | Independent proof                             | Status           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- | ---------------- |
| Bun, `mise`, OXC, and TypeScript toolchain                              | [DEVELOPMENT.md](DEVELOPMENT.md)                                       | Validation gate and lockfile checks           | proven           |
| Effect Schema boundary validation                                       | [ARCHITECTURE.md](ARCHITECTURE.md), [DEPENDENCIES.md](DEPENDENCIES.md) | Source and boundary tests                     | proven           |
| Eleven canonical native Role.task identities and route-only profiles    | [BEHAVIOR.md](BEHAVIOR.md)                                             | Core catalog, registration, and routing tests | proven           |
| Root orchestration and Assignment-backed delegation                     | [BEHAVIOR.md](BEHAVIOR.md), [STATE.md](STATE.md)                       | Core policy and plugin contract tests         | proven           |
| Repo-local Intent/Plan/Assignment persistence                           | [STATE.md](STATE.md)                                                   | Agent store and CLI tests                     | proven           |
| Product profile migration and Astra/Luna routing                        | [CONFIGURATION.md](CONFIGURATION.md), [BEHAVIOR.md](BEHAVIOR.md)       | CLI and routing boundary tests                | proven           |
| Codex-owned context-management setting                                  | [CONFIGURATION.md](CONFIGURATION.md), [STATE.md](STATE.md)             | Maintenance and migration tests               | proven           |
| Independent service tiers                                               | [BEHAVIOR.md](BEHAVIOR.md), [CONFIGURATION.md](CONFIGURATION.md)       | Configuration boundary tests                  | proven           |
| CLI install, remove, version, JSON, and exit behavior                   | [CLI.md](CLI.md)                                                       | CLI boundary tests                            | proven           |
| Native Codex plugin management, owned state, and transactional recovery | [INSTALLATION.md](INSTALLATION.md), [STATE.md](STATE.md)               | Isolated install/removal/doctor verification  | proven           |
| Work, frontend, Security, and Computer Use selections                   | [BEHAVIOR.md](BEHAVIOR.md), [SECURITY.md](SECURITY.md)                 | Denial and typed-port tests                   | capability-gated |
| Secret exclusion and fail-closed behavior                               | [SECURITY.md](SECURITY.md)                                             | Security and redaction tests                  | proven           |
| Evidence admissibility and provenance                                   | [PROVENANCE.md](PROVENANCE.md)                                         | Repository proof and changed-file inspection  | proven           |
| Exact release artifact and publication gates                            | [RELEASING.md](RELEASING.md)                                           | CI artifact digest and release checks         | proven           |

Every row has one owner. A change updates that owner and its proof instead of
copying a claim into another document.
