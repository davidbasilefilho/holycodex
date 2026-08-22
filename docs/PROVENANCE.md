# HolyCodex provenance ledger

This document owns evidence admissibility, identity records, and limitation
claims. Contract decisions are marked as decisions; they are not disguised as
historical compatibility or live-provider facts.

## Clean-room boundary

The only admissible inputs for this foundation are:

1. The user-provided task specification, stable profile, and explicit
   completion criteria.
2. The expressly supplied official current-source dossier.
3. Files authored in this repository, generated artifacts checked into this
   repository, and repository-native tests or scripts, only to prove the
   implementation and internal consistency.

No claim is inferred from an unprovided historical implementation, remembered
behavior, public summary, package name, or live provider. Network, package,
plugin, MCP, and external repository material is not evidence unless the task
context expressly admits it.

## Evidence classes

| ID     | Source class                                                            | Supports                                                                                                       | Does not support                                                                          |
| ------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `P-01` | Task specification and stable profile                                   | Release scope, requested documents, clean-room rule, roles, values, capability limits, and completion criteria | Undocumented historical behavior or compatibility                                         |
| `P-02` | Supplied official current-source dossier                                | Current Codex, toolchain, dependency, protocol, and license facts stated in the dossier                        | Live-provider availability or guarantees beyond the dossier                               |
| `P-03` | Local implementation, generated provenance, and repository-native proof | Implemented behavior, deterministic fixtures, local validation, and checked-in identities                      | Canonical external clone, post-push Actions, publication, deployment, or external cutover |
| `D-01` | Authored behavioral contract                                            | Observable choices required to make this foundation testable                                                   | Proof of an earlier product                                                               |
| `D-02` | Authored architecture, security, installation, and cutover contracts    | Package ownership, trust boundaries, recovery, and approval-gated operations                                   | Authorization to perform an external mutation                                             |

The denylist is a boundary rather than a proof obligation. Historical source,
history or diff, generated internal material from another project, undocumented
compatibility assumptions, and unadmitted external material remain outside the
clean-room input set.

## Foundation identities

The parity matrix in [PARITY.md](PARITY.md) owns surface status. Package
ownership remains in [ARCHITECTURE.md](ARCHITECTURE.md); dependency purpose and
attribution remain in [DEPENDENCIES.md](DEPENDENCIES.md) and
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

| Identity                 | Recorded value                                                                       | Evidence        | Reproduction or limitation                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Clean-room base          | `682adea6d6cba374251152af612489126e9c64c1`                                           | `P-01`          | Assignment-provided SHA; repository-local consistency only                                                            |
| Frozen behavioral oracle | `eb796235f2f29f2c67c869408a0e22c1a72c13eb`                                           | `P-01`          | Assignment-provided SHA; no historical source is admissible                                                           |
| Public version           | Canonical `version` in `packages/cli/package.json`                                   | `P-01` / `D-02` | The manifest is the sole version authority                                                                            |
| Bun                      | `1.4.x`, resolved `1.4.0`                                                            | `P-01` / `P-03` | `mise.toml`, root manifest, lockfile, and validation gate agree                                                       |
| TypeScript               | `7.0.2`                                                                              | `P-01` / `P-03` | Checked-in lock entry and manifests                                                                                   |
| Vite+                    | `0.2.9`                                                                              | `P-01` / `P-03` | Root manifest and lockfile                                                                                            |
| Effect                   | `3.22.1`                                                                             | `P-01` / `P-03` | All workspace package manifests and source boundary scans use `effect/Schema`                                         |
| Codex CLI                | `codex-cli 0.148.0`                                                                  | `P-01` / `P-03` | Executable SHA-256 `ac2cfed85fb647d61e0150b8548102b330e4799d9d81ad5d354de701edf6b074`; observed path is host-specific |
| Generated inventory      | 943 files, digest `24436be19cd8ea368d18154da5d8354b9b6ce1671da1fb49e958a6341d3e7d7d` | `P-03`          | Sorted path/size/SHA-256 inventory under `packages/codex/generated/codex-cli-0.148.0/`                                |
| Protocol epoch           | `codex-app-server-0.148.0`                                                           | `P-02` / `P-03` | Checked-in generated provenance and protocol tests                                                                    |
| `multi_agent_v2`         | Locally disabled; distinct generated lifecycle unverified                            | `P-01` / `P-03` | Advertised V2 fails closed; stable App Server fallback is executable                                                  |

## Generated artifact

The checked-in artifact was produced with the exact Codex executable and these
commands, using separate generated roots:

```sh
codex app-server generate-ts --out <artifact-root>/typescript
codex app-server generate-json-schema --out <artifact-root>/json-schema
```

`provenance.json` records the executable path, version, executable digest,
commands, protocol epoch, capability evidence, file count, and inventory
digest. `scripts/repository-proof.ts` re-derives the sorted file inventory and
rejects a mismatch. The artifact is proof of the checked-in generated surface,
not proof that a live provider exposes every generated capability.

## Validation evidence and limits

The completed local gate recorded 15 files and 98 tests, package smoke,
artifact/provenance/architecture checks, dependency and license checks,
fixture fresh-clone and dry-run checks, and `git diff --check`. Checked-in CI
is configured for Ubuntu and Windows/Git Bash but post-push required-job
evidence is pending until an approved push. A real canonical fresh clone and
external repository cutover metadata are likewise pending. Token-backed npm
publication is configured as an approval-gated manual GitHub Actions workflow;
its run and registry read-back remain external evidence. GitHub release
publication and deployment remain excluded.

Local proof does not establish legal advice, security certification,
performance, availability, compatibility with an unrecorded provider, or
fitness for a purpose. Subsequent changes must update the owning document and
evidence class instead of copying a claim into another owner.
