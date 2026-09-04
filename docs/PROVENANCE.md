# HolyCodex provenance

This ledger defines what evidence may support a claim. It is the source of
truth for evidence admissibility, version identity, generated assets, and
validation limits.

## Contribution evidence boundary

The admissible input set is:

1. The current task specification and explicitly supplied current-source
   facts.
2. Files authored in this repository for internal consistency.
3. Repository-native tests, scripts, manifests, lockfile, and local command
   output used to prove implemented behavior.

Undocumented historical implementations, prompts, skills, hooks, bundles,
source, and behavior are outside the boundary. A local result does not claim
parity with an unadmitted source.

## Evidence classes

| ID     | Source                                           | Permitted use                                                                                |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `P-01` | Task specification and stable profile            | Project identity, evidence boundary, roles, values, capabilities, and requested deliverables |
| `P-02` | Supplied current-source dossier                  | Current Codex, toolchain, dependency, and license facts stated there                         |
| `P-03` | Local implementation and repository-native proof | Implemented behavior, generated plugin assets, and local validation evidence                 |
| `D-01` | Authored contract decisions                      | New observable choices required for a coherent implementation; not historical facts          |

## Recorded identities

| Identity                 | Recorded value                                                                                                               | Evidence       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Source baseline          | `682adea6d6cba374251152af612489126e9c64c1`                                                                                   | `P-01`         |
| Frozen behavioral oracle | `eb796235f2f29f2c67c869408a0e22c1a72c13eb`                                                                                   | `P-01`         |
| Public version           | `packages/cli/package.json` `version`, synchronized to the plugin manifest                                                   | `P-01`, `P-03` |
| Bun                      | `1.4.x`, resolved by `mise` and the lockfile                                                                                 | `P-01`, `P-03` |
| TypeScript               | `7.0.2`                                                                                                                      | `P-01`, `P-03` |
| OXC tooling              | `oxfmt`/`oxlint` compatibility lines resolved by Bun lockfile                                                                | `P-01`, `P-03` |
| Effect                   | `3.22.1` with `effect/Schema`                                                                                                | `P-01`, `P-03` |
| Codex protocol artifact  | Stable Codex CLI resolved by the `mise.toml` `latest` channel; inventory and digest recorded by the generated artifact proof | `P-02`, `P-03` |

The manifest, lockfile, generated assets, and version script are the
repository-native identity checks. Release publication is configured through
GitHub Actions, but external registry and release readback remain evidence
from the specific approved run.

The generated Codex protocol types are produced under
`packages/codex/generated/` before validation and packaging. This directory is
fully ignored by VCS; its source executable, protocol epoch, file inventory,
and SHA-256 identity are recorded in local generated provenance and
re-verified by the generated artifact proof.

## Validation limits

The local validation gate proves formatting, linting, type checking, Bun tests,
Bun package build/pack, plugin asset integrity, dependency attribution,
isolated installation/removal, and diff hygiene. Checked-in CI adds
supported-platform proof. `Worker.operations` may observe a triggering origin
change only from the exact ref and SHA; observation does not prove an external
mutation. Root delegates every task and retains integration/completion
authority.
A passing `Reviewer.code` fixed point is required before completion or VCS.
Remote CI/release evidence is delegated against the exact ref and SHA and
must be terminal.

Local proof does not establish legal advice, security certification,
performance, availability, compatibility with an unrecorded provider, or
fitness for a purpose. Subsequent changes update the owning document and
evidence class instead of copying a claim into another owner.
