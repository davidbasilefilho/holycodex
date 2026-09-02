# HolyCodex parity matrix

This matrix records the clean-room baseline and independent proof for the
0.16 surface. It is evidence, not the behavioral authority; current behavior
belongs to [BEHAVIOR.md](BEHAVIOR.md), package placement to
[ARCHITECTURE.md](ARCHITECTURE.md), CLI wire behavior to [CLI.md](CLI.md),
security to [SECURITY.md](SECURITY.md), release boundaries to
[RELEASING.md](RELEASING.md), and evidence limits to [PROVENANCE.md](PROVENANCE.md).

## Baseline and admissible difference

| Identity                         | Exact value                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Clean-room base SHA              | `682adea6d6cba374251152af612489126e9c64c1`                                                                             |
| Frozen behavioral oracle SHA     | `eb796235f2f29f2c67c869408a0e22c1a72c13eb`                                                                             |
| Foundation version               | Canonical `version` in `packages/cli/package.json`                                                                     |
| Permitted operational difference | `Worker.operations` observes CI after an approved origin change from the exact ref and SHA, without mutation authority |

`proven` means repository-native proof exists. `capability-gated` means the
selection and denial path is proven locally while live provider availability is
not claimed. `external pending` is reserved for approved remote actions and
their readback.

## Required surface inventory

| Surface                                               | Owner                                                                  | Independent proof                            | Status           |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- | ---------------- |
| Bun, `mise`, TypeScript, and Vite+ toolchain          | [DEVELOPMENT.md](DEVELOPMENT.md)                                       | Validation gate and lockfile checks          | proven           |
| Effect Schema boundary validation                     | [ARCHITECTURE.md](ARCHITECTURE.md), [DEPENDENCIES.md](DEPENDENCIES.md) | Source and boundary tests                    | proven           |
| Native role/task identities and route-only plans      | [BEHAVIOR.md](BEHAVIOR.md)                                             | Core catalog and routing tests               | proven           |
| Independent service tiers                             | [BEHAVIOR.md](BEHAVIOR.md), [CONFIGURATION.md](CONFIGURATION.md)       | Configuration boundary tests                 | proven           |
| CLI install, remove, version, JSON, and exit behavior | [CLI.md](CLI.md)                                                       | CLI boundary tests                           | proven           |
| Native Codex plugin management and owned state        | [INSTALLATION.md](INSTALLATION.md), [STATE.md](STATE.md)               | Isolated install/remove smoke                | proven           |
| Work, frontend, Security, and Computer Use selections | [BEHAVIOR.md](BEHAVIOR.md), [SECURITY.md](SECURITY.md)                 | Denial and typed-port tests                  | capability-gated |
| Secret exclusion and fail-closed behavior             | [SECURITY.md](SECURITY.md)                                             | Security and redaction tests                 | proven           |
| Clean-room admissibility and provenance               | [PROVENANCE.md](PROVENANCE.md)                                         | Repository proof and changed-file inspection | proven           |
| Exact release artifact and publication gates          | [RELEASING.md](RELEASING.md)                                           | CI artifact digest and release checks        | proven           |

Every row has one owner. A change updates that owner and its proof instead of
copying a claim into another document.
