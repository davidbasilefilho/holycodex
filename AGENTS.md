# HolyCodex development rules

HolyCodex is a Codex plugin and CLI that supplies native subagent profiles,
route policy, typed boundaries, and native plugin setup. Keep one authority for
each concern and every change mergeable.

Root owns user intent, scope, architecture, product and policy choices,
material risk, integration, external state, all Git/VCS inspection and
mutation, and the final readiness judgment. Root delegates every substantive
non-VCS operation to a named native Explorer, Librarian, Worker, or Reviewer
seam. Leaves execute only their literal boundary, preserve project contracts,
and return evidence; they do not make Root decisions or perform Git/VCS work.

Before any subagent dispatch, Root ensures `writing-for-agents` is fully loaded
and applied in the current context. Reuse it for later dispatches while its
complete instructions remain available; reload after compaction, a new
context, or an incomplete/unavailable earlier load. Each delegation names one
owner, exact scope, retained constraints, evidence, exclusions, escalation,
and an observable completion criterion. Root inspects and integrates returned
evidence rather than accepting it blindly.

Before implementation, Root obtains the user's explicit plan approval through
native `request_user_input`. Immediately before each exact push, Root obtains
fresh user approval for that ref/SHA through the same tool. Root cannot approve
its own user-gated action; unknown or materially risky effects fail closed.

Split genuine parallel work into bounded, independently mergeable seams. Keep
dependency direction and typed/public boundaries coherent, reuse an existing
boundary when it has real callers or clear near-term value, avoid pointless
file splitting and speculative abstraction, and make the smallest goal-specific
diff. Verify proportional stable behavior before adding tests; remove temporary
debug/generated output before handoff and keep build/release artifacts ignored
by VCS except legitimate checked-in generated type definitions.

Environment secrets, credentials, raw environment values, private keys, and
secret-bearing release material must never enter tracked files, commits,
packages, logs, CI artifacts, or uploads. Before any VCS mutation, verify
candidate paths with the repository ignore rules (for example,
`git check-ignore -v --no-index`) and inspect the staged file list; if a secret
is not ignored or appears in a diff, stop and fail closed. Never print secret
values while investigating or reporting.

Use local/dev verification before broader dev or staging checks, and only then
production/stable actions. After each approved push, delegate exact-ref/SHA CI
observation to `Worker.operations`; pending or running checks are incomplete,
and the observer may only read and report terminal evidence.

Use Bun and `mise` for the pinned toolchain:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run validate
git diff --check
```

Before handoff, Root inspects the final diff and proves relevant validation,
package graph, generated assets, and release invariants. The canonical version
is maintained by the version script in both
`packages/cli/package.json` and
`packages/plugin/assets/.codex-plugin/plugin.json`. Publishing is configured
through the checked-in GitHub Actions release pipeline and remains approval-
gated.

Source-of-truth pointers:

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) owns package placement and flow.
- [BEHAVIOR.md](docs/BEHAVIOR.md) owns observable behavior and routing.
- [CLI.md](docs/CLI.md) owns command syntax and envelopes.
- [INSTALLATION.md](docs/INSTALLATION.md) owns native setup and removal.
- [SECURITY.md](docs/SECURITY.md) owns trust and secret boundaries.
- [RELEASING.md](docs/RELEASING.md) owns version and publication gates.
- [PROVENANCE.md](docs/PROVENANCE.md) owns admissible evidence.

Contributions use the task specification, current source facts, and files
authored in this repository. Preserve unrelated user work and stop at the
assigned completion criterion.

## Contribute

Keep the diff minimal, retain ownership boundaries, run the smallest relevant
proof plus the full validation gate when practical, and report changed files,
commands, results, residual risk, and any exact decision Root must make.

## License

Repository-authored material is licensed under [Apache-2.0](LICENSE).
