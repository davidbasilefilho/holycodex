# HolyCodex development rules

- Use Bun as the only runtime, package manager, script runner, and test runner. Use `mise` to pin and invoke the toolchain; do not use npm, pnpm, or yarn.
- Use Vite+ tooling and current TypeScript 7. Keep the toolchain cohesive: do not add ESLint, Prettier, or redundant Vite+ tools.
- Validate every external, persisted, CLI, App Server, and specialist boundary with Effect Schema from `effect/Schema`. Keep internal values typed; do not use `any` or unjustified casts.
- Prefer Bun-native APIs and small cohesive packages. Keep dependency direction one-way, preserve trust boundaries, and put policy in one owning module.
- QuickJS TypeScript workflows are the production path. Type-check and validate them before evaluation; approval happens before host effects, runtime owns deterministic mechanics, and Root owns judgment.
- Use the normative contract in [docs/BEHAVIOR.md](docs/BEHAVIOR.md), package/flow ownership in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), CLI wire rules in [docs/CLI.md](docs/CLI.md), security rules in [docs/SECURITY.md](docs/SECURITY.md), and evidence limits in [docs/PROVENANCE.md](docs/PROVENANCE.md). Link to an owner instead of duplicating its rules.
- Add SPDX `Apache-2.0` headers to authored code; Markdown is excluded. Run the appropriate Bun, Vite+, TypeScript, and repository checks before completion, including `git diff --check`.
- Work under the clean-room rule: use only the task specification and the expressly supplied official current-source dossier. Do not read, search, import, quote, adapt, or compare any legacy HolyCodex, OmO, or LazyCodex implementation, history, prompt, skill, hook, agent, bundle, or source.
