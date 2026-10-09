# First native DEV publication

This is a maintainer handoff, not an installation guide. Run no publishing or
security-setting commands until Root coordinates the DEV action. Stable is not
authorized. Do not create placeholder packages. The three platform packages
must contain the real, validated release-profile executables.

## Why owner action is necessary

The [npm trust CLI prerequisites](https://docs.npmjs.com/cli/v12/commands/npm-trust/)
explicitly require the package to exist, write access, and account 2FA. The
[scoped public publishing guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
requires public access for these names. Thus the first real platform tarballs
must be published by an npm maintainer authorized in `@turndev`; after that,
the owner can configure their individual trusted publishers. GitHub write
access does not prove npm scope ownership. No shared token is needed in this
handoff: the owner uses their own interactive npm login and browser/2FA.

At implementation time the registry had only the principal `holycodex`
(`latest=0.16.12`, `dev=0.16.12-dev.124.1`); the three scoped native names returned
404. The main wrapper is not published during bootstrap. Its dependencies must
already exist before it can become installable.

## Build in CI before any publication

`native-validation.yml` has a dedicated push trigger for
`codex/native-validation/**`, read-only repository permissions, and no publishing
or OIDC job. A maintainer creates a fresh validation branch pointing at the
reviewed PR12 SHA. Unlike manual dispatch, this push trigger does not require
registering the new workflow on the default branch. It calls the same DEV/native
validation and uploads four tarballs without an npm or GitHub release.
`publish.yml` has no manual dispatch; do not use its old default-branch entry.

The commands below are a template for a fresh PowerShell validation run, using
existing authorized GitHub CLI access and Node 26/npm 12.2.0 for the owner
operation. Owner publishing and settings commands have not been executed.
The already started read-only run is `37811540553`, with payload source
`ec0453b86257ab5f84cf441c70894c6c938fa0c5`, branch
`codex/native-validation/ec0453b86257ab5f84cf441c70894c6c938fa0c5`, and version
`0.17.0-1.dev.37811540553`. Its current status must be checked before reuse.
The reviewed large-payload verifier is commit
`65e936fc93186b0917d898f7bddd455283b32425`. Do not start a duplicate run merely
because the documentation or verifier commit differs from the payload source.
For a new run, keep it on the exact reviewed feature HEAD:

```powershell
$Repo = 'davidbasilefilho/holycodex'
$SourceBranch = 'codex/dev-publishing-entry'
$SourceSha = gh pr view 12 --repo $Repo --json headRefOid --jq .headRefOid
if ($LASTEXITCODE -ne 0) { throw 'Cannot read PR12 head' }
if (Test-Path 'holycodex-native-bootstrap') { throw 'Choose a fresh checkout directory' }
git clone --single-branch --branch $SourceBranch "https://github.com/$Repo.git" holycodex-native-bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Source clone failed' }
Set-Location holycodex-native-bootstrap
git checkout --detach $SourceSha
if ($LASTEXITCODE -ne 0) { throw 'Reviewed source checkout failed' }

$Branch = "codex/native-validation/$SourceSha"
$Existing = git ls-remote origin "refs/heads/$Branch"
if ($LASTEXITCODE -ne 0 -or $Existing) { throw 'Choose a fresh validation branch; do not overwrite an existing ref' }
git push origin "${SourceSha}:refs/heads/$Branch"
if ($LASTEXITCODE -ne 0) { throw 'Validation branch push failed' }
gh run list --repo $Repo --workflow native-validation.yml --branch $Branch --event push --limit 10 --json databaseId,headSha,status,conclusion,createdAt,url
```

Select the new run whose `headSha` equals `$SourceSha`; do not take an older run
or a quality run. After all native jobs succeed, download and validate it:

```powershell
$RunId = Read-Host 'ID of the native-bootstrap-validation run at the reviewed source SHA'
gh run watch $RunId --repo $Repo --exit-status
if ($LASTEXITCODE -ne 0) { throw 'Native validation failed; do not bootstrap' }
$Run = gh run view $RunId --repo $Repo --json headSha,event,status,conclusion,headBranch | ConvertFrom-Json
if ($Run.headSha -ne $SourceSha -or $Run.headBranch -ne $Branch -or $Run.event -ne 'push' -or $Run.conclusion -ne 'success') { throw 'Wrong source or run' }
$Version = "0.17.0-1.dev.$RunId"
$Artifacts = '.tmp/bootstrap-artifacts'
if (Test-Path $Artifacts) { throw 'Choose a fresh artifact destination' }
gh run download $RunId --repo $Repo --pattern "holycodex-$Version-*-$SourceSha" --dir $Artifacts
if ($LASTEXITCODE -ne 0) { throw 'Artifact download failed' }
node npm/packager/verify-release.cjs $Artifacts $SourceSha $Version
if ($LASTEXITCODE -ne 0) { throw 'Artifact identity validation failed' }
```

Run the verifier from a reviewed PR12 checkout and record its helper commit.
`$SourceSha` always identifies the native run's payload source. An independently
reviewed verifier-only fix can use a different helper commit while still
requiring every artifact to match `$SourceSha`. The verifier compares large
executables in bounded chunks; do not use the superseded 1 MiB-buffer helper.
The four artifact directories are named
`holycodex-$Version-{wrapper,darwin-arm64,linux-x64-gnu,win32-x64}-$SourceSha`.
Each has `source-revision.toml` and exactly one matching tarball:

| npm package | Exact tarball basename |
|---|---|
| `@turndev/holycodex-native-darwin-arm64` | `turndev-holycodex-native-darwin-arm64-$Version.tgz` |
| `@turndev/holycodex-native-linux-x64-gnu` | `turndev-holycodex-native-linux-x64-gnu-$Version.tgz` |
| `@turndev/holycodex-native-win32-x64` | `turndev-holycodex-native-win32-x64-$Version.tgz` |
| `holycodex` | `holycodex-$Version.tgz` |

`$Version` is exact once the native validation run ID is known. Run `37811540553`
uses `0.17.0-1.dev.37811540553`; this identity is not evidence that native jobs
have passed or that their tarballs exist. This run predates the distribution
stripping, size budgets and packed-native smoke gate. Its completed Linux
package was 706.5 MB compressed with two approximately 1.4 GB executables and
fails the current 256 MiB archive / 384 MiB per-alias budgets. It is diagnostic evidence,
not a bootstrap candidate. Before publication, a reviewed source containing the
packaging fix must pass native validation on all three targets and generate new
matching artifacts. Stripping an old downloaded binary for comparison does not
create new CI provenance or authorize rewriting `source-revision.toml`.
Do not substitute old Linux/debug
payloads, fixture executables, or a differently versioned platform package.
The native jobs retain locked upstream tests, release-profile compilation,
packaging and isolated installer mechanics. Manual runtime/visual/host acceptance
still needs its own evidence; fixture installation is not native runtime proof.

## Publish only the three real platform tarballs once

Root must approve the verified run/source and owner operation first. An npm
owner with write access to `@turndev` performs these commands locally, accepting
the normal interactive browser/2FA prompts. Do not put a token or password in
shell commands, GitHub secrets, issue comments or this repository:

```powershell
npm login --registry=https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Owner login failed' }
npm whoami --registry=https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Owner identity unavailable' }
$Platforms = @('darwin-arm64', 'linux-x64-gnu', 'win32-x64')
foreach ($Platform in $Platforms) {
    $Package = "@turndev/holycodex-native-$Platform"
    $Archive = @(Get-ChildItem $Artifacts -Recurse -File -Filter "turndev-holycodex-native-$Platform-$Version.tgz")
    if ($Archive.Count -ne 1) { throw "Expected one exact tarball for $Package" }
    $ArchivePath = $Archive[0].FullName
    npm publish $ArchivePath --access public --tag dev --registry=https://registry.npmjs.org --provenance=false
    if ($LASTEXITCODE -ne 0) { throw "Bootstrap stopped at $Package; do not publish the wrapper" }
    $Expected = node -e "const fs=require('node:fs'),c=require('node:crypto');process.stdout.write('sha512-'+c.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64'))" $ArchivePath
    $Actual = npm view "$Package@$Version" dist.integrity --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0 -or $Actual -ne $Expected) { throw "Registry integrity differs for $Package" }
    $Tag = npm view $Package dist-tags.dev --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0 -or $Tag -ne $Version) { throw "DEV tag differs for $Package" }
}
```

The first owner-local publish cannot claim CI-generated npm provenance; it
uses the already verified CI tarball and explicit `--provenance=false`.
Subsequent automated publishes use OIDC/provenance. This does not weaken the
native locked tests or artifact verifier. If publication/readback fails, stop
and reconcile only the affected package through the owner; do not republish a
conflicting version or advance the wrapper. These commands never use `latest`.

## Configure the four trusted publishers as owner

This is a separate owner security-setting action; Codex does not execute it.

Before enabling npm OIDC, the repository administrator must create and verify
GitHub **Settings → Environments → holycodex-publish** with:

- Deployment branches and tags set to **Selected branches and tags**, with
  exactly branch `next` and tag `v0.17.0-1`; no wildcard or pull-request refs.
- Protect `next` so repository writers cannot directly push, force-push or
  delete it outside the authorized integration policy. Sensitive workflow,
  packager and runtime changes must receive the owner's authorized review
  before reaching that ref. Restrict bypass/merge authority to trusted release
  owners; protect the review ownership/rules themselves.
- Protect creation, update and deletion of `v0.17.0-1` with a tag ruleset whose
  permitted release actors are the authorized owner(s), not all repository
  writers. This configuration does not authorize executing stable.

This is the minimum automatic route under the finding's threat model: ordinary
repository writers may create feature branches but cannot advance accepted
release refs or change security settings without owner authorization. After an
authorized merge to `next`, CI can publish without a second deployment approval.
The npm environment constraint is essential; a feature workflow that removes
`environment:` no longer matches it, while one that retains it is denied by the
external ref restrictions. Environment rules alone are insufficient if any
writer can update an accepted branch or create the accepted tag.

**Optional extra deployment approval:** required environment reviewers plus
**Prevent self-review** add a manual gate to every DEV/stable publishing job.
Only one of the configured reviewers must approve, but the initiating actor
cannot approve their own run when self-review is prevented. This can require a
second trusted maintainer; a solo owner may otherwise block their own releases.
It is a GitHub protection option, not an npm requirement. Use it if Root wants
that separate approval or accepted refs cannot be adequately protected; it is
not required by this automatic release design. If enabled, restrict admin
bypass according to the chosen independent-approval policy.

[GitHub documents these external protections](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
YAML `environment:` alone does not create protection: an absent environment can
be auto-created unprotected. Verify the settings before integration. npm must
require the same environment for **all four** packages. A publisher without
that environment constraint permits a modified branch workflow to bypass the
repository code; inspect existing publishers and stop for owner approval of
any replacement. No live environment or npm configuration was changed or
verified here. Until both configurations are confirmed, OIDC publication is
blocked, even if CI is green.

Open each package page, then **Settings → Trusted Publisher → GitHub Actions**:

- [macOS ARM64](https://www.npmjs.com/package/@turndev/holycodex-native-darwin-arm64)
- [Linux x64 GNU](https://www.npmjs.com/package/@turndev/holycodex-native-linux-x64-gnu)
- [Windows x64](https://www.npmjs.com/package/@turndev/holycodex-native-win32-x64)
- [principal holycodex](https://www.npmjs.com/package/holycodex)

Use GitHub organization/user **davidbasilefilho**, repository **holycodex**,
workflow filename **publish.yml**, environment name **holycodex-publish**, and
allow direct **npm publish**. Stage-only permission is insufficient. Do not
change other security/access settings. Inspect the existing principal publisher
first; retain it if it already matches. If it differs, stop for coordinated
owner approval rather than revoking or replacing it automatically.

The owner may use the documented CLI instead of the website, after separate
approval of the setting change; for each newly created platform package:

```powershell
npm trust github "@turndev/holycodex-native-darwin-arm64" --file publish.yml --repo davidbasilefilho/holycodex --environment holycodex-publish --allow-publish
npm trust github "@turndev/holycodex-native-linux-x64-gnu" --file publish.yml --repo davidbasilefilho/holycodex --environment holycodex-publish --allow-publish
npm trust github "@turndev/holycodex-native-win32-x64" --file publish.yml --repo davidbasilefilho/holycodex --environment holycodex-publish --allow-publish
npm trust list holycodex
```

Check package existence, the bootstrap version/integrity/dev tag and publisher
settings before integration. Newly configured publishers need a first successful
OIDC publish within two days according to the [npm trusted-publishing guide](https://docs.npmjs.com/trusted-publishers/).

## Integration order for the first coordinated DEV

Preserve the stack with merge commits, inspecting current heads/checks after
each step. Do not merge PR10 first and publish an incomplete `next`:

1. Merge PR12 into `codex/babysit-ci-upstream-boundary` (PR11's branch).
2. Revalidate PR11's new head, then merge PR11 into `codex/pr9-c8b7d19-checkpoint` (PR10's branch).
3. Revalidate PR10's new head, confirm npm bootstrap/settings, then merge PR10 into `next`.
4. That final `next` push triggers the complete DEV build/publication. Its new
   run ID produces a new exact DEV version for all four packages. Platform
   readbacks precede the wrapper; GitHub prerelease follows all npm readbacks.

The initial bootstrap version is not reused for a different source/build/run.
PR9 (`next` → `main`) is not required for this DEV route, and no stable tag is
created. Manual dispatch is confined to validation workflows and has a
different filename from the npm publisher. The dedicated validation branch is
never an allowed deployment branch in `holycodex-publish`.
