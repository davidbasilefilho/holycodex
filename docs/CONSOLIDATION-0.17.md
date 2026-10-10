# Preserved HolyCodex 0.17 history

The owner first requested one consolidated release PR, then superseded that
request with separate semantic branches and PRs in a stack. The cumulative
checkpoint `07ab5990c873272194734c078b3f5887257b70ee` preserves every active
0.17 layer; its final publication-routing changes belong on
`release/v0.17.0/release-routing`, targeting `native-followthrough` rather than
creating a redundant aggregate PR. See [BRANCHES.md](BRANCHES.md).

GitHub renamed `next` to `release/v0.17.0` on 2026-10-10 without changing its
commit, automatically closing PR9. The authorized cumulative fast-forward
caused GitHub to mark PR10 merged into that release branch; `main` was not
changed. Subsequent semantic renames require replacement head PRs because
GitHub closes open head PRs on rename. Keep links to the original discussions
and unresolved findings. Verify actual remote state after each step.

## Preserved current work

These exact heads are ancestors of the cumulative checkpoint:

| Source | Preserved commit |
| --- | --- |
| Original `next` / PR9 | `5680340b448ba36355c52fa52cab048333a4c802` |
| PR10 runtime/TOON/daemon fixes | `c8b7d19f411007060191ea93a42c4dc6e6fb9408` |
| PR11 upstream event boundary | `d14045ec7c44a4d202155844211f643d49492f27` |
| PR12 publishing and native validation | `4a92573d0240bb980bb4c1c5035db9307323321a` |
| PR13 stable/DEV version correction | `85030274a042b86bd07874e5d070b494b72784d3` |
| PR14 recovered runtime/auth/package/license work | `9b99e52cae9f86b761e714318d1eedf0839e9e92` |
| Windows installer response regression | `a30ffd80a89653b8e07aaeaac40efa884db399be` |

The original unpublished checkpoint `4d8c30ec3bc6fcda6f1f7890e793dc6354db6709`
was recovered without discarding its content. Its exact original commit is
preserved in the recovery bundle; the supported GitHub commit upload produced
`0c6e333aa2ea3113dbb677387323cef7b7acf8b9` with the identical source tree.

## Complete branch inventory and historical exceptions

All 20 remote branches and all six then-open PRs were checked before
consolidation. All open PR heads, `main`, `codex/holycodex-0.15.0`, the three
older native-validation branches, and these historical release branches are
already ancestors: `release/0.16.7-1`, `release/v0.16.9`, `release/v0.16.9-1`,
`release/v0.16.9-2`, and `release/v0.16.11`.

The only non-ancestor work was inspected and deliberately retained on its
historical branches rather than reintroducing an obsolete implementation:

- `codex/native-artifact-proof/37925386518` and
  `codex/native-artifact-proof-prepared/37925386518` both point to
  `0125fb8ac00a99f831f464b5a891ad6b5054ac8d`. Their two unique commits add one
  read-only proof workflow pinned to an older run and `0.17.0-1` artifacts.
  The current `release.yml`, `verify-release.cjs`, `native-smoke.cjs` and
  `installation-smoke.cjs` cover actual four-archive identity, native launch
  and exact offline installation on each target with the current version.
  Old proof results remain historical evidence, never final-candidate proof.
- `release/0.15-remediation` remains at
  `f6389d4eae30b499da7a42b96ac0813485c1dd40`. Its 17 unique commits change 14
  files for the legacy TypeScript workflow-store/public package API, Vite
  packaging, old release identity/publisher and associated documentation/legal
  packaging. The 0.17 native rewrite intentionally supersedes that JS package
  architecture. Importing its old package/publisher files would restore
  incompatible behavior. The complete source remains on that branch; this
  inventory does not claim every old workflow API was ported to native 0.17.

No historical branch is deleted by this reorganization.

## Review and publication boundaries

Closing a superseded PR is administrative, not a finding resolution. Carry
forward the unresolved protected-ref/OIDC finding from PR12, native license
text reconciliation and required host/platform compatibility evidence.
The stable/DEV SemVer correction from PR13 is included and has regression
coverage; explicit legacy prerelease ranges retain their documented meaning.

Ordinary accepted-release-branch pushes only validate. DEV publication requires a
separately authorized explicit `publish.yml` dispatch on `release/v0.17.0/release-routing`
with `publish_dev=true`; all build/pack/install gates and external environment
restrictions still apply. No merge, npm write or stable release is implied by
branch reorganization or by opening review PRs.
