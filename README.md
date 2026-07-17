# HolyCodex

## What

HolyCodex is a lean Codex-only hard fork of [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). It packages a Codex-native multi-agent workflow, focused engineering skills, scoped rules, readiness hooks, LSP and Context7 integrations, and a safe Git Bash bridge for native Windows.

## Why

HolyCodex keeps the useful engineering discipline of its upstream project while removing OpenCode-specific machinery and minimizing persistent prompt cost. It gives Root clear ownership, delegates bounded work to purpose-built specialists, validates external data at runtime, and preserves user configuration across install, upgrade, and cleanup.

The goal is a small, predictable Codex toolkit: strong defaults, explicit dangerous actions, reproducible checks, and no permanent terminal UI or hidden autonomy.

## How it works

Root is the default user-facing agent. It owns user interaction, intent, scope, architecture, product decisions, ambiguity resolution, integration, final judgment, and final verification. The selected routing plan configures Root and each specialist; explicit user model preferences are preserved.

| Plan      | Root                 | Explorer           | Librarian          | Worker               |
| --------- | -------------------- | ------------------ | ------------------ | -------------------- |
| `go`      | GPT-5.6 Terra medium | GPT-5.6 Terra low  | GPT-5.6 Terra low  | GPT-5.6 Terra medium |
| `plus`    | GPT-5.6 Sol medium   | GPT-5.6 Luna low   | GPT-5.6 Luna low   | GPT-5.6 Terra high   |
| `pro-5x`  | GPT-5.6 Sol high     | GPT-5.6 Terra high | GPT-5.6 Terra high | GPT-5.6 Sol medium   |
| `pro-20x` | GPT-5.6 Sol xhigh    | GPT-5.6 Sol medium | GPT-5.6 Sol medium | GPT-5.6 Sol high     |

Bounded independent work is presumed delegable to the cheapest capable specialist:

| Specialist  | Scope                                                           |
| ----------- | --------------------------------------------------------------- |
| `explorer`  | Bounded read-only repository facts                              |
| `librarian` | Bounded current external research from primary sources          |
| `worker`    | Isolated implementation after Root fixes architecture and proof |

Root delegates repository inspection when it likely needs more than two root tool calls, spans multiple files or symbols, asks a separable factual question, or can run while root handles decisions. It delegates current external research when multiple primary sources, version or date verification, or a bounded factual answer is needed. It delegates implementation after architecture, behavior, scope, constraints, write ownership, proof, and stop conditions are fixed. Root retains user interaction, intent, architecture, product decisions, ambiguity resolution, integration, final judgment, and final verification.

Root uses at most two specialists in one wave by default. Packets carry five concepts: exact outcome or question, allowed scope, constraints and fixed decisions, required evidence or proof, and stop and blocker conditions. Optional context stays optional. Local work is reserved for atomic or tightly coupled work, unresolved architecture, unsafe isolation, or cases where dispatch plus review is concretely more expensive. Specialists do not delegate, overlap write ownership, review one another, retry unchanged packets, or raise their model or effort automatically. Root reviews actual returns before spot-checking only load-bearing claims, avoids duplicate reassurance work, integrates results, and performs final verification.

HolyCodex also ships 16 on-demand skills, scoped rules, readiness hooks, LSP and Context7 MCPs, and a Windows-only Git Bash MCP. Planning, plan review, and goal definition print exact activation headings. A durable goal is created only after explicit user consent. Zod schemas validate CLI input, configuration, manifests, persisted state, MCP and JSON-RPC envelopes, LSP responses, daemon messages, environment values, and metadata scripts at their runtime boundaries.

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
holycodex install --plan go                    # lower-cost routing plan
holycodex install --plan plus                  # default routing plan
holycodex install --plan pro-5x                # higher-capability routing plan
holycodex install --plan pro-20x               # highest-capability routing plan
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

Release validation follows [Vite+ guidance](https://cdn.jsdelivr.net/npm/vite-plus@latest/AGENTS.md): `vp install`, `vp check --fix`, `vp test`, and `vp run` for configured build/version tasks.

## Thanks

HolyCodex exists because of YeonGyu Kim and the oh-my-openagent contributors, Julius Brussee and caveman contributors, the authors credited in `packages/plugin/plugin/skills/frontend/ATTRIBUTION.md`, and the upstream projects listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Thank you to everyone who built, reviewed, documented, tested, or maintained the projects that HolyCodex depends on.

## Licenses

HolyCodex uses the [Sustainable Use License 1.0](LICENSE.md), not MIT. Third-party components retain their original licenses and notices.
