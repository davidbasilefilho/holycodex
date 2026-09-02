# HolyCodex

## What?

HolyCodex is a clean-room Codex plugin and `holycodex` CLI. It installs the
repository's native subagent profiles and keeps configuration small, typed,
and owned by one package.

Its package graph keeps domain, Codex, plugin, and CLI seams one-way. Native
agent types are selected by route and return bounded evidence to Root.

## Why?

The Codex platform already owns plugin installation and subagent execution.
HolyCodex supplies the routing policy, safe configuration boundary, and
optional capability selection without introducing a second execution engine.

## How?

Install through the published CLI and Codex's native plugin management:

```sh
bunx holycodex install
```

Remove the installed HolyCodex scope through the same native boundary:

```sh
bunx holycodex remove
```

Choose a plan for routing only and choose the service tier independently:

```sh
bunx holycodex install --yes --plan plus --tier standard
```

The available plans select native subagent routes. A tier changes service
handling only; it does not change routes, authority, or proof requirements.

Optional Codex plugins are explicit selections:

```sh
bunx holycodex install --yes --work --frontend --security --computer-use
```

The four optional selections are Work, frontend tooling, Security, and
Computer Use. Missing or unavailable capabilities fail closed.

For repository work, use the pinned toolchain:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run validate
```

Read the owning contracts for [architecture](docs/ARCHITECTURE.md),
[behavior](docs/BEHAVIOR.md), [CLI](docs/CLI.md),
[installation](docs/INSTALLATION.md), [security](docs/SECURITY.md), and
[provenance](docs/PROVENANCE.md).

## Contribute

Use Bun through `mise`, keep changes on the smallest mergeable seam, and run
the checks that prove it. Preserve the clean-room boundary: use the task
specification, admitted current-source facts, and repository-authored files;
do not import undocumented historical implementation material.

## License

HolyCodex is licensed under [Apache-2.0](LICENSE).
