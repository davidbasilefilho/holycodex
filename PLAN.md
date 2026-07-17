# HolyCodex npm package and dev-channel plan

Status: implemented and verified on `dev`. Durable goal declined.

1. Preserve the current dirty 0.6.0 worktree and baseline package, CLI, install, and lifecycle behavior.
2. Make root a private Vite+ workspace. Create public `packages/cli` as `holycodex` and public `packages/plugin` as `@holycodex/plugin`; keep their versions and dependency exact.
3. Move root `src` and `bin` into the CLI package. Move plugin assets into the plugin package. Repair marketplace, imports, tests, manifests, hooks, version surfaces, and generated paths.
4. Export a narrow installed plugin-root resolver. Make installer and packed CLI consume `@holycodex/plugin` instead of assuming a sibling asset directory.
5. Split Vite+ output: CLI to `packages/cli/dist`; bootstrap, rules, Git Bash, and LSP runtime to `packages/plugin/plugin/runtime`.
6. Add dependency-free TTY/`NO_COLOR` presentation for help, warnings, lifecycle summaries, and doctor output. Preserve JSON, plain redirected output, exit codes, and noninteractive behavior.
7. Update `publish.yml` for ordered stable publication. Add `dev.yml` with unique CI prerelease versions and npm `dev` tagging so `bunx holycodex@dev` resolves without moving `latest`.
8. Add package-layout, version-rewrite, workflow, renderer, install, packed-resolution, and package-content contracts. Update documentation, migration guidance, notices, and npm prerequisites.
9. Run `vp install`, `vp check`, `vp test`, `vp run build`, `vp run version:check`, strict package types, separate package dry-runs, packed-tarball installation, CLI smoke tests, and final Git audit. Do not publish locally.

Acceptance: both tarballs are independently valid; CLI installs assets from its exact plugin dependency; stable and dev workflows publish plugin before CLI; `bunx holycodex@dev` is enabled after the first successful dev publication; all deterministic checks pass.
