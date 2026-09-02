# HolyCodex development rules

## What?

HolyCodex is a clean-room Codex plugin and CLI. The repository supplies native
subagent profiles, route policy, typed boundaries, and native plugin setup.

## Why?

Keep one authority for each concern and keep every change mergeable. Root owns
intent, scope, architecture, product and policy choices, material risk,
integration, external state, and the final readiness judgment. Workers execute
literal bounded seams and return evidence; they do not make Root decisions.

## How?

Root orchestrates the work. Assign one named seam to each leaf Worker, require
the Worker to inspect callers and owning contracts, and keep boundaries small
enough to merge independently. A Worker may edit only its assigned files,
repair bounded defects, run proportional checks, and stop with exact evidence.
Reviewers inspect the actual integrated diff once and repair only their owned
findings. Material architecture, interface, scope, trust, or release choices
return to Root.

Plans select routing only. Service tiers are independent settings. Native
subagents own execution; repository code must not grow a parallel execution
engine, hidden scheduler, or alternate capability path.

After every triggering origin change, `Worker.operations` babysits CI from the
exact ref and SHA. It may observe required checks and report the result; it may
not rerun, cancel, edit, approve, merge, push, tag, publish, deploy, or mutate
external state. A changed ref or SHA is a new observation request.

Use Bun and `mise` for the pinned toolchain:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run validate
git diff --check
```

Before handoff, inspect the final diff and prove the relevant validation,
package graph, generated assets, clean-room, and release invariants. The
canonical version is maintained by the version script in both
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

Contributions use only the task specification, expressly admitted current
source facts, and files authored in this repository. Do not read, search,
import, quote, adapt, or compare undocumented historical implementation
material. Preserve unrelated user work and stop at the assigned completion
criterion.

## Contribute

Keep the diff minimal, retain ownership boundaries, run the smallest relevant
proof plus the full validation gate when practical, and report changed files,
commands, results, residual risk, and any exact decision Root must make.

## License

Repository-authored material is licensed under [Apache-2.0](LICENSE).
