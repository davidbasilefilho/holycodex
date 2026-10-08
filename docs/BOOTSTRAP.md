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

The default branch already contains a dispatchable `publish.yml` from the old
layout, while new `release.yml` is absent there. GitHub allows [dispatch on a
selected branch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
when the workflow exists on the default branch. Use the updated `publish.yml`
on PR12's branch with `validation_only=true`. It calls DEV/native validation
and uploads four tarballs, but the publication job is skipped: no npm publish,
OIDC exchange, GitHub release, or release tag is performed.

The commands below are for PowerShell, using existing authorized GitHub CLI
access and Node 26/npm 12.2.0 for the owner operation. They are prepared, not
executed by Codex. Keep this initial run on the exact reviewed feature HEAD:

```powershell
$Repo = 'davidbasilefilho/holycodex'
$Branch = 'codex/dev-publishing-entry'
$SourceSha = gh pr view 12 --repo $Repo --json headRefOid --jq .headRefOid
if ($LASTEXITCODE -ne 0) { throw 'Cannot read PR12 head' }
if (Test-Path 'holycodex-native-bootstrap') { throw 'Choose a fresh checkout directory' }
git clone --single-branch --branch $Branch "https://github.com/$Repo.git" holycodex-native-bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Source clone failed' }
Set-Location holycodex-native-bootstrap
git checkout --detach $SourceSha
if ($LASTEXITCODE -ne 0) { throw 'Reviewed source checkout failed' }

gh workflow run publish.yml --repo $Repo --ref $Branch -f validation_only=true
if ($LASTEXITCODE -ne 0) { throw 'Validation-only dispatch failed' }
gh run list --repo $Repo --workflow publish.yml --branch $Branch --event workflow_dispatch --limit 10 --json databaseId,headSha,status,conclusion,createdAt,url
```

Select the new run whose `headSha` equals `$SourceSha`; do not take an older run
or a quality run. After all native jobs succeed, download and validate it:

```powershell
$RunId = Read-Host 'ID of the validation-only run at the reviewed source SHA'
gh run watch $RunId --repo $Repo --exit-status
if ($LASTEXITCODE -ne 0) { throw 'Native validation failed; do not bootstrap' }
$Run = gh run view $RunId --repo $Repo --json headSha,event,status,conclusion,headBranch | ConvertFrom-Json
if ($Run.headSha -ne $SourceSha -or $Run.headBranch -ne $Branch -or $Run.event -ne 'workflow_dispatch' -or $Run.conclusion -ne 'success') { throw 'Wrong source or run' }
$Version = "0.17.0-1.dev.$RunId"
$Artifacts = '.tmp/bootstrap-artifacts'
if (Test-Path $Artifacts) { throw 'Choose a fresh artifact destination' }
gh run download $RunId --repo $Repo --pattern "holycodex-$Version-*-$SourceSha" --dir $Artifacts
if ($LASTEXITCODE -ne 0) { throw 'Artifact download failed' }
node npm/packager/verify-release.cjs $Artifacts $SourceSha $Version
if ($LASTEXITCODE -ne 0) { throw 'Artifact identity validation failed' }
```

Run the verifier from a checkout at `$SourceSha`, containing PR12's scripts.
The four artifact directories are named
`holycodex-$Version-{wrapper,darwin-arm64,linux-x64-gnu,win32-x64}-$SourceSha`.
Each has `source-revision.toml` and exactly one matching tarball:

| npm package | Exact tarball basename |
|---|---|
| `@turndev/holycodex-native-darwin-arm64` | `turndev-holycodex-native-darwin-arm64-$Version.tgz` |
| `@turndev/holycodex-native-linux-x64-gnu` | `turndev-holycodex-native-linux-x64-gnu-$Version.tgz` |
| `@turndev/holycodex-native-win32-x64` | `turndev-holycodex-native-win32-x64-$Version.tgz` |
| `holycodex` | `holycodex-$Version.tgz` |

`$Version` is exact once the native validation run ID is known. There is no
bootstrap tarball/run ID yet; do not invent one or substitute old Linux/debug
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
Open each package page, then **Settings → Trusted Publisher → GitHub Actions**:

- [macOS ARM64](https://www.npmjs.com/package/@turndev/holycodex-native-darwin-arm64)
- [Linux x64 GNU](https://www.npmjs.com/package/@turndev/holycodex-native-linux-x64-gnu)
- [Windows x64](https://www.npmjs.com/package/@turndev/holycodex-native-win32-x64)
- [principal holycodex](https://www.npmjs.com/package/holycodex)

Use GitHub organization/user **davidbasilefilho**, repository **holycodex**,
workflow filename **publish.yml**, no environment name for this workflow, and
allow direct **npm publish**. Stage-only permission is insufficient. Do not
change other security/access settings. Inspect the existing principal publisher
first; retain it if it already matches. If it differs, stop for coordinated
owner approval rather than revoking or replacing it automatically.

The owner may use the documented CLI instead of the website, after separate
approval of the setting change; for each newly created platform package:

```powershell
npm trust github "@turndev/holycodex-native-darwin-arm64" --file publish.yml --repo davidbasilefilho/holycodex --allow-publish
npm trust github "@turndev/holycodex-native-linux-x64-gnu" --file publish.yml --repo davidbasilefilho/holycodex --allow-publish
npm trust github "@turndev/holycodex-native-win32-x64" --file publish.yml --repo davidbasilefilho/holycodex --allow-publish
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
created. Default `publish.yml` dispatch with `validation_only=false` requires
`next`; dispatching it on the feature branch without the flag fails closed.
