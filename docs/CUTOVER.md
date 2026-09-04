# Repository cutover runbook

This is a historical, approval-gated runbook retained for evidence. It is
inert until a human confirms the exact target and command; it does not define
current product behavior or the native plugin installation path.

This runbook owns the repository rename and archival sequence. It preserves
issues, pull requests, releases, license metadata, provenance, branches, and
history. Every external mutation is a separate approval gate. Publication,
deployment, package or registry actions, tags, and releases are out of scope.

The runbook is intentionally inert until a human confirms the exact target,
authority, current ref, and next command immediately before that command.
Abort on any mismatch; never repair a preflight mismatch by guessing.

## 1. Set the recorded targets

Run from a clean checkout of the intended cutover branch. Replace `OWNER` with
the verified GitHub owner and keep these values visible in the cutover record:

```sh
set -eu
OWNER='REPLACE_WITH_VERIFIED_OWNER'
LEGACY_REPO="$OWNER/holycodex"
NEXT_REPO="$OWNER/holycodex-next"
NEW_REPO="$OWNER/holycodex"
BRANCH='main'
FROZEN_ORACLE_SHA='eb796235f2f29f2c67c869408a0e22c1a72c13eb'
BASE_SHA='682adea6d6cba374251152af612489126e9c64c1'
NEW_REMOTE="https://github.com/$OWNER/holycodex.git"
```

`LEGACY_REPO` and `NEXT_REPO` must be confirmed from the repository owner and
remote inventory. Do not assume that the local remote owner has authority over
either repository.

## 2. Read-only preflight

Run every check below before any rename, archive, metadata write, remote write,
or push. Save the outputs in the external cutover record without storing
credentials or tokens.

```sh
gh auth status
git remote -v
git branch --show-current
git rev-parse HEAD
git status --short --branch
git diff --check
git rev-parse "$FROZEN_ORACLE_SHA^{commit}"
git rev-parse "$BASE_SHA^{commit}"
mise exec -- bun packages/cli/src/index.ts version
mise exec -- bun run validate
gh repo view "$LEGACY_REPO" --json nameWithOwner,isArchived,defaultBranchRef,description,homepage,licenseInfo
gh repo view "$NEXT_REPO" --json nameWithOwner,isArchived,defaultBranchRef,description,homepage,licenseInfo
gh api "repos/$LEGACY_REPO/branches/$BRANCH/protection"
gh api "repos/$NEXT_REPO/branches/$BRANCH/protection"
gh issue list --repo "$LEGACY_REPO" --state all --limit 1000 --json number,title,state,url
gh issue list --repo "$NEXT_REPO" --state all --limit 1000 --json number,title,state,url
gh pr list --repo "$LEGACY_REPO" --state all --limit 1000 --json number,title,state,url
gh pr list --repo "$NEXT_REPO" --state all --limit 1000 --json number,title,state,url
gh release list --repo "$LEGACY_REPO" --limit 1000
gh release list --repo "$NEXT_REPO" --limit 1000
gh api "repos/$LEGACY_REPO/license" --jq '.license.spdx_id'
gh api "repos/$NEXT_REPO/license" --jq '.license.spdx_id'
git show HEAD:docs/PROVENANCE.md | sed -n '1,220p'
git show HEAD:docs/PARITY.md | sed -n '1,120p'
```

Preflight passes only when the caller is authorized for both repositories, the
remote and branch are the intended ones, protections and required checks are
recorded, issues/PRs/releases/licenses are accounted for, the worktree is
clean, validation passes, and the frozen/base identities match the cutover
record. A `gh api` 404 for a protection rule is a fact to resolve, not proof
that no protection is required. Approval to continue is separate from every
later mutation and must explicitly cover the authorized account, remote
identities, protections, issue/PR/release inventories, license metadata,
provenance, and frozen/base SHA evidence recorded here.

## 3. Rename and archive the legacy repository

Record the current repository metadata and its API response before each step.
Confirm the exact command, then perform each mutation separately:

1. Approval gate: rename `LEGACY_REPO` to `holycodex-legacy`.

   ```sh
   gh api --method PATCH "repos/$LEGACY_REPO" -f name='holycodex-legacy'
   ```

2. Read-only verification: set `LEGACY_REPO="$OWNER/holycodex-legacy"`, then
   verify the repository URL, default branch, branch protection, issue/PR/release
   counts, license metadata, and provenance references. Stop if any data is
   missing or redirected unexpectedly.

3. Approval gate: archive the renamed legacy repository. Archiving preserves
   data and makes the historical repository read-only.

   ```sh
   gh api --method PATCH "repos/$LEGACY_REPO" -F archived=true
   ```

4. Read-only verification: confirm `isArchived` is true and repeat the issue,
   pull-request, release, license, and branch inventory checks. Do not delete
   the repository or any of its contents.

Abort before the next step if rename or archive verification fails. If an
approved rollback is required, unarchive with `-F archived=false` as its own
approval-gated mutation and verify before continuing.

## 4. Rename the new repository

Confirm that the legacy repository is archived and the new repository
still has the recorded metadata. Then obtain approval for this one repository
rename and perform it as a separate gate:

```sh
gh api --method PATCH "repos/$NEXT_REPO" -f name='holycodex'
```

Set `NEW_REPO="$OWNER/holycodex"` after the API confirms the rename. Verify the
new canonical URL, default branch, branch protection, issues, pull requests,
releases, license metadata, the frozen oracle/base record, and the current
provenance and parity documents. No tag, release, package publication,
deployment, or registry action belongs in this step.

If verification fails, stop. A rollback rename to `holycodex-next` is a new
approval-gated mutation; preserve the repository and its data while resolving
the failure.

## 5. Update local remotes and repository metadata

Only after the remote rename is verified, obtain approval for this one local
remote mutation, then confirm and apply the change:

```sh
git remote set-url origin "$NEW_REMOTE"
git remote -v
```

Update repository description, homepage, topics, or other metadata only from
the values approved in the preflight record. Each metadata write is a separate
approval gate and must be followed by a read-back. Preserve license and
provenance metadata; do not replace them with inferred values.

## 6. Push verification

The current branch must still be clean, on the approved branch, and at the
approved validation commit. Confirm the exact ref immediately before the push.
Then obtain a fresh approval for this one external mutation:

```sh
git status --short --branch
git rev-parse HEAD
git push --set-upstream origin "$BRANCH"
```

Read-only push verification is:

```sh
git ls-remote --heads origin "$BRANCH"
gh run list --repo "$NEW_REPO" --branch "$BRANCH" --limit 20
```

Do not retry a failed or uncertain push by changing the ref. Record the error,
remote state, and exact commit for Root/user resolution.

## 7. Real canonical fresh clone and CI observation

After the approved push, obtain separate approval for this read-only external
network gate, then run the real network clone against the new canonical
repository and the exact branch ref:

```sh
mise exec -- bun scripts/fresh-clone.ts \
  --url "$NEW_REMOTE" \
  --ref "refs/heads/$BRANCH" \
  --network
```

The command installs the frozen lockfile and runs the repository validation in
a temporary clone. Keep the clone result and checked-out SHA in the cutover
record. The existing fixture and dry-run proofs do not substitute for this
canonical clone.

After the push succeeds, delegate exact-ref/SHA CI observation to
`Worker.operations` and inspect the required Ubuntu and Windows/Git Bash jobs.
The observer may read status and report evidence only; it has no permission to
rerun, cancel, edit, approve, merge, push, tag, publish, deploy, or otherwise
mutate external state. Per the parity decision, post-push CI green is
nonblocking for this cutover record.

## Abort and recovery points

- Before each approval gate: abort with no mutation when authority, identity,
  metadata, branch protection, issue/PR/release inventory, license, provenance,
  frozen SHA, or worktree state differs from the record.
- After a rename: verify before archive or the next rename; rollback is a new
  explicit rename request.
- After archive: unarchive only through a separate approval and preserve all
  historical data.
- After the repository rename: update the local remote only after read-back;
  restore the prior local URL separately if required.
- After push: preserve the exact remote response and commit; do not force-push,
  rewrite history, delete repositories, or invent a new ref to repair an
  uncertain result.

The cutover is complete only when the new canonical remote, preserved legacy
archive, metadata read-backs, push ref, fresh-clone result, and CI observation
record are all attached to the validation evidence. Publication, deployment,
tagging, releases, and registry actions remain excluded.
