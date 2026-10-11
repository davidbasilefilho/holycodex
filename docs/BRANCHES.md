# Release branches and PR stacks

## Policy for the target codebase

Follow the target codebase's applicable branch and PR conventions and current
maintainer decisions first. Only when none apply, choose from these two fallback
families if they fit the project's versioning and workflow triggers:

- `release/<version>/<type>/<change>` for release work, for example
  `release/v0.17.0/fix/windows-install`.
- `exp/<experiment>/<type>/<change>` for experimental work, for example
  `exp/sqlite-history/feat/storage`.

Both fallbacks preserve mergeability. Choose a descriptive type and change name;
the examples do not create a mandatory type catalog or authorize other fallback
root prefixes. Keep the project's actual release version and full suffix. Do not
impose HolyCodex's zero-major convention on another project or rename an already
valid branch just to use a fallback. Actual PR bases and dependencies determine
an approved stack. Naming alone never establishes stack registration or order,
or authorizes a merge, release, deployment, or permission change.

## HolyCodex repository convention

HolyCodex's own release stack uses `release/v<version>/<semantic-change>`, for example
`release/v0.17.0/native-auth` or `release/v0.17.0-1/sandbox-packaging`.
Versions are zero-major SemVer. Preserve an optional version suffix exactly;
`0.17.0` and `0.17.0-1` are different release identities. Choose a concise
semantic change name, not an arbitrary sequence number.
Use the established three-segment convention for new HolyCodex work. Existing
`release/v0.17.0/fix/assignment-revision-evidence` and other `/fix/` stack heads
remain valid: the validator accepts this compatibility form and preserves its
complete change path and version suffix. Do not rename these heads or change
their PR dependencies merely to adopt the three-segment recommendation. Other
four-segment types are not part of this repository convention; the generic
fallback families above apply only where no project convention exists.

A stack has one branch and one normal PR per substantial change. The first
PR targets the accepted base (normally `main`); every successor targets the
preceding branch. The final branch contains its predecessors' commits. Order
is represented by real PR dependencies, not by names or a redundant aggregate
PR. A single substantial change needs one PR. Do not claim native GitHub stack
registration merely because base branches form a chain; verify registration
through a supported interface when it is used.

Before reorganizing, inventory every relevant remote head and open PR, review
unresolved findings and workflow triggers, and prove preserved ancestry or
explicitly reconcile unique changes. A bare `release/v<version>` ref cannot
coexist with descendants because Git uses the same path namespace. Rename an
existing bare ref to its actual semantic layer before creating children. A
supported temporary rename can resolve this collision while retaining the
same commit; verify each result. Account for GitHub's automatic head-PR
closure, preserve original review links, and recreate the corresponding
review PR when necessary. Do not delete historical work or equate closure
with resolution. Do not rewrite independent changes.

`npm/packager/release-branch.cjs` validates names, exact suffix identity,
linear PR dependency plans and prefix conflicts against a supplied remote
branch inventory for HolyCodex's own release stack. It is not a universal
validator for projects that use different conventions. It performs no Git/API
mutation and grants no authorization.
The positive and negative tests run in the normal `mise run test` gate.
Canonical model-facing ownership is in the Root instruction overlay.

Naming and stack maintenance do not grant merge, publication, deployment or
security-setting permission. Validate the exact current head and GitHub's
selected merge-check target, carry unresolved findings forward, and complete
independent general/security review, fixes and reverification before merge.
Explicit publication approval, protected refs, all-platform builds/packs and
artifact identity gates remain separate requirements. Do not trigger a
publisher merely to test a branch rename or stack setup.
