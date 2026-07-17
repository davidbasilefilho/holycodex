# HolyCodex

HolyCodex is a lean Codex-only hard fork of [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). It keeps useful engineering workflows, removes OpenCode-specific machinery, and minimizes persistent prompt cost for ChatGPT Plus.

## Architecture

Root is the default user-facing agent. It uses GPT-5.6 Sol at medium reasoning unless the user already configured either root value. Root owns intent, scope, architecture, user decisions, integration, final judgment, and final verification.

Three specialists are available when delegation costs less than doing the work locally:

| Specialist  | Model              | Scope                                                           |
| ----------- | ------------------ | --------------------------------------------------------------- |
| `explorer`  | GPT-5.6 Luna low   | Bounded read-only repository facts                              |
| `librarian` | GPT-5.6 Luna low   | Bounded current external research from primary sources          |
| `worker`    | GPT-5.6 Terra high | Isolated implementation after root fixes architecture and proof |

Before substantial work, root separates root-owned decisions from independent slices. It uses at most two specialists in one wave by default. Packets carry an exact outcome, scope, unchanged constraints, forbidden expansion, acceptance evidence, blocker behavior, and stop condition. Root keeps work local when it is trivial, coupled, unresolved, unsafe to isolate, or cheaper than packet creation and integration. Specialists do not recursively delegate, review one another, retry unchanged work, or raise their model or effort automatically.

HolyCodex also ships 16 on-demand skills, scoped rules, readiness hooks, LSP and Context7 MCPs, and a Windows-only Git Bash MCP. Planning, plan review, and goal definition print exact activation headings. A durable goal is created only after explicit user consent.

## Platform behavior

| Platform        | MCP defaults                  | Shell policy                                                                                                |
| --------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Native Windows  | `git_bash`, `lsp`, `context7` | Every shell action uses the allowlisted Git Bash `run` tool; installation stops if Git Bash is unavailable. |
| Linux and macOS | `lsp`, `context7`             | Native shell tools; Git Bash configuration and prompt rules are omitted.                                    |

The shared MCP process layer bounds runtime, caps captured output while preserving its head and tail, resolves exactly once, and terminates process trees on timeout or early protocol success.

## Install

```sh
npx holycodex install
# or
bunx holycodex install
```

Development builds use npm's `dev` channel:

```sh
bunx holycodex@dev install
bunx holycodex@dev doctor
```

Each development workflow run publishes a unique prerelease and moves only the `dev` dist-tag. Stable `latest` remains unchanged.

Installation is noninteractive. It backs up affected files, removes legacy OMO state after backup, preserves unrelated configuration and explicit model preferences, installs the plugin and effective platform MCPs, and configures:

- `features.multi_agent = true` and request-user-input support;
- `agents.max_threads = 2` and `agents.max_depth = 1`;
- named-agent `config_file` entries;
- a status line containing remaining context;
- workspace network access in contained modes;
- local unauthenticated Context7 through `bunx @upstash/context7-mcp`.

Version 0.6.0 migrates the old managed worker default from Luna medium to Terra high. Values that do not match a known HolyCodex-managed default are treated as explicit user preferences and preserved. Cleanup restores values that existed before HolyCodex management.

```sh
holycodex install                              # on-request, workspace-write, network on
holycodex install --codex-autonomous           # never ask, workspace-write, network on
holycodex install --dangerous-codex-autonomous # never ask, unrestricted host access
holycodex install --no-codex-autonomous        # same contained behavior as no flag
holycodex install --json
holycodex doctor
holycodex doctor --json
holycodex --help
holycodex --version
```

Dangerous autonomy prints an explicit warning and is never inferred. `doctor` distinguishes missing Bun or `bunx`, malformed or stale Context7 configuration, package resolution and startup failures, model/config drift, platform-inapplicable Git Bash, and healthy operation.

Human CLI output uses a compact TTY-aware presentation and honors `NO_COLOR`. JSON output and redirected text remain stable and noninteractive. OpenTUI is intentionally absent because HolyCodex does not run a persistent terminal interface.

Codex may ask you to trust installed command hooks. This security review is the only expected manual installation step.

## Multi-agent compatibility

HolyCodex uses the documented Codex `features.multi_agent`, `agents.max_threads`, `agents.max_depth`, and per-agent `config_file` surfaces. Codex 0.144.4 locally reports `multi_agent` as stable and enabled, while `multi_agent_v2` is under development and disabled. HolyCodex therefore does not write an undocumented v2 flag. Configuration and deterministic tests prove the intended specialist model files and routing contracts; they do not prove live provider-side model selection for every Codex release.

## Cleanup

```sh
npx holycodex cleanup
# or
bunx holycodex cleanup
```

Cleanup backs up affected state, removes only HolyCodex-owned configuration and artifacts, and restores managed values. Install and cleanup are idempotent.

## Repository layout

- `packages/cli/` — public `holycodex` executable, source, metadata, and generated CLI bundle.
- `packages/plugin/` — public `@holycodex/plugin` package containing prompts, skills, agents, hooks, MCP metadata, and generated plugin runtime.
- `packages/git-bash-mcp/`, `packages/lsp-*`, and `packages/mcp-stdio-core/` — internal runtime packages.
- `vite.config.ts` — Vite+ plugin-runtime build; `packages/cli/vite.config.ts` builds the CLI.
- `test/` — lifecycle, configuration, instruction, catalogue, protocol, and platform tests.

The root package is private and orchestrates the Vite+ workspace. The CLI depends on the exact same version of `@holycodex/plugin`, resolves its installed asset root, and copies only that payload into Codex state.

## npm publishing

`.github/workflows/publish.yml` is the only npm publishing workflow. It uses npm trusted publishing for pushes to both `main` and `dev`, publishes `@holycodex/plugin` before `holycodex`, and never uses a long-lived npm credential.

- `main` publishes the intentional repository version with the explicit `latest` tag. Each package is skipped when that exact version already exists, so non-version changes do not fail or republish.
- `dev` removes any prerelease suffix from the repository version, derives `<base>-dev.<GITHUB_RUN_ID>.<GITHUB_RUN_ATTEMPT>`, applies it only inside the runner, builds with that embedded version, and publishes with the explicit `dev` tag.

Configure npm trusted publishing separately for `holycodex` and `@holycodex/plugin` with:

```text
Trusted publisher provider: GitHub Actions
GitHub owner: davidbasilefilho
Repository: holycodex
Workflow filename: publish.yml
Allowed action: npm publish
```

Both `main` and `dev` must be protected because either branch contains an npm-authorized workflow. No GitHub environment is currently used. If one is added, its workflow `environment` name must exactly match the optional environment configured in npm trusted publishing.

Resulting npm resolution:

```text
npm install holycodex         -> stable version tagged latest, published from main
npm install holycodex@latest  -> same stable version
npm install holycodex@dev     -> newest unique prerelease published from dev
```

Release validation follows [Vite+ guidance](https://cdn.jsdelivr.net/npm/vite-plus@latest/AGENTS.md): `vp install`, `vp check`, `vp test`, and `vp run` for configured build/version tasks.

## Attribution and license

HolyCodex exists because of YeonGyu Kim and the oh-my-openagent contributors, Julius Brussee and caveman contributors, the authors credited in `packages/plugin/plugin/skills/frontend/ATTRIBUTION.md`, and the upstream projects listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

HolyCodex uses the [Sustainable Use License 1.0](LICENSE.md), not MIT. Third-party components retain their original licenses and notices.
