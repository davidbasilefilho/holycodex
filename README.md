# HolyCodex

HolyCodex is a lean Codex toolkit derived from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). It installs a Codex-native multi-agent workflow, focused engineering skills, scoped rules, readiness hooks, LSP and Context7 integrations, and a safe Git Bash bridge on native Windows.

## Install

```sh
npx holycodex install
# or
bunx holycodex install
```

Restart Codex and open a new task after installation. Codex may ask you to trust the installed command hooks.

Use `doctor` to inspect installation health:

```sh
npx holycodex doctor
```

## Plans and agents

Root owns user interaction, scope, architecture, integration, and final verification. Root uses `plan-review` once before plan approval and `code-review` once after code or manifest implementation; neither review belongs to a reviewer agent. Explorer handles bounded repository discovery, Librarian handles current primary-source research, and Worker handles isolated implementation after Root fixes the contract without owning final verification.

Current routing values are:

| Plan        | Root               | Explorer           | Librarian          | Worker             | Direct subagents |
| ----------- | ------------------ | ------------------ | ------------------ | ------------------ | ---------------: |
| `go`        | GPT-5.6 Luna xhigh | GPT-5.6 Luna high  | GPT-5.6 Luna high  | GPT-5.6 Luna xhigh |                0 |
| `plus-low`  | GPT-5.6 Sol low    | GPT-5.6 Luna high  | GPT-5.6 Luna high  | GPT-5.6 Luna high  |                1 |
| `plus`      | GPT-5.6 Sol medium | GPT-5.6 Luna high  | GPT-5.6 Luna high  | GPT-5.6 Luna xhigh |                2 |
| `plus-high` | GPT-5.6 Sol medium | GPT-5.6 Luna xhigh | GPT-5.6 Luna xhigh | GPT-5.6 Luna max   |                2 |
| `pro-5x`    | GPT-5.6 Sol high   | GPT-5.6 Luna xhigh | GPT-5.6 Luna xhigh | GPT-5.6 Luna max   |                2 |
| `pro-20x`   | GPT-5.6 Sol high   | GPT-5.6 Luna max   | GPT-5.6 Luna max   | GPT-5.6 Luna max   |                2 |

`plus` is the balanced default. It gives Root Sol medium for high-leverage decisions, Explorer and Librarian Luna high, and Worker Luna xhigh. `plus-low` uses Sol low and Luna high specialists. `plus-high`, `pro-5x`, and `pro-20x` increase specialist reasoning. `go` uses Luna xhigh for Root and Worker with Luna high research specialists.

The [DeepSWE v1.1 cost-performance analysis](docs/deepswe-v1.1.md) uses supplied costs that are already repriced for the July 30, 2026 GPT-5.6 changes. Luna high has the best measured cost per success among efforts allowed in active routing. Luna xhigh is the stronger delegated-work option while remaining inexpensive. Luna high beats Terra medium by 9.1 percentage points while costing about 67% less, and Luna xhigh costs about 82% less than Terra xhigh for only 3.3 percentage points less score. Terra is therefore mostly outside the current measured cost-performance frontier.

Relative cost per successful task is the primary usage-efficiency metric. Absolute capability is secondary because failed delegated work creates Root rework. Steps, orchestration reliability, latency, and output speed are tertiary. Sol remains preferred for paid-plan Root routes because orchestration failures affect the entire workflow; its roughly 51 to 53 expected steps per success can justify the premium over Luna high and xhigh at roughly 111 to 125. Active subagents use Luna only. `plus-high` and `pro-5x` use Luna max for Worker, while `pro-20x` uses Luna max for all specialists.

All plans use subagent depth 1. The plan-selected direct subagent limit is emitted as `agents.max_threads`, which includes Root, so HolyCodex writes one more thread than the displayed value. Override it with `--max-subagents 0..3`.

```sh
holycodex install --plan plus-high
holycodex install --max-subagents 3
holycodex install --plan plus-low --fast
```

Explicit user model preferences and unrelated configuration remain preserved during upgrades and cleanup. Historical HolyCodex routes are retained only as migration recognition, allowing existing installations to move to the current routes without treating stale managed values as user overrides.

## Platform behavior

| Platform        | MCP defaults                  | Shell behavior                                                                                      |
| --------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| Native Windows  | `git_bash`, `lsp`, `context7` | Shell actions use the allowlisted Git Bash bridge. Installation stops when Git Bash is unavailable. |
| Linux and macOS | `lsp`, `context7`             | Codex native shell tools remain active.                                                             |

HolyCodex restores native Codex workspace I/O. It does not install an editing MCP. Skills use native `apply_patch` and available native read or shell tools.

## Options

```sh
holycodex install                              # Fresh install: Approve for me; upgrades preserve permissions
holycodex install --plan <plan>
holycodex install --max-subagents <0..3>
holycodex install --fast                       # Fast for generated subagents; Root stays Standard
holycodex install --fast-all                   # Fast for Root and all generated subagents
holycodex install --no-fast                    # Standard for Root and all generated subagents
holycodex install --codex-autonomous           # never ask; workspace-write; network on
holycodex install --dangerous-codex-autonomous # never ask; unrestricted host access
holycodex install --no-codex-autonomous        # Approve for me; workspace-write; network on
holycodex install --json
holycodex doctor [--json]
holycodex --help
holycodex --version
```

For example:

```sh
holycodex install --fast       # faster delegated work, Standard Root
holycodex install --fast-all   # faster Root and delegated work
holycodex install --no-fast    # explicit Standard behavior
```

The Fast flags are mutually exclusive. Any pair or the three-flag combination is rejected with a validation error. Omitting all Fast flags behaves exactly like `--no-fast`.

| Mode         | Root     | Explorer | Librarian | Worker   |
| ------------ | -------- | -------- | --------- | -------- |
| no Fast flag | Standard | Standard | Standard  | Standard |
| `--no-fast`  | Standard | Standard | Standard  | Standard |
| `--fast`     | Standard | Fast     | Fast      | Fast     |
| `--fast-all` | Fast     | Fast     | Fast      | Fast     |

Codex Fast consumes exactly `2.5×` as much subscription usage as Standard and produces output tokens about `1.5×` faster. It does not improve model quality or expected agent-step count. Fast is therefore a latency option, not the usage-efficiency default. HolyCodex changes only `service_tier` for Fast modes, directly in Root and every generated agent-role configuration.

Installation is noninteractive, backs up affected files, preserves unrelated configuration, and configures multi-agent support, selected agent capacity, specialist profiles, status context, and platform MCPs. Upgrading from the former global `--fast` behavior removes stale HolyCodex-managed global Fast state and writes deterministic Root and per-agent tiers for the selected mode. Dangerous autonomy remains explicit and is never inferred.

A fresh install with no autonomy flag seeds Codex's Approve for me permission mode. On an existing HolyCodex installation, omitting all autonomy flags preserves the complete current Codex permission selection, including Full access, Ask for approval, built-in profiles, and custom profiles. An explicit autonomy flag intentionally replaces the active selection with its documented root permission tuple. HolyCodex never generates `default_permissions` or selects a named permission profile.

| Installation mode                  | Approval policy | Reviewer      | Sandbox              |
| ---------------------------------- | --------------- | ------------- | -------------------- |
| Default or `--no-codex-autonomous` | `on-request`    | `auto_review` | `workspace-write`    |
| `--codex-autonomous`               | `never`         | unset         | `workspace-write`    |
| `--dangerous-codex-autonomous`     | `never`         | unset         | `danger-full-access` |

Bundled skills include explicit UI metadata and use the `HolyCodex: <Skill Name>` display brand, including `HolyCodex: LSP`, `HolyCodex: AST Grep`, and `HolyCodex: LSP Setup`.

During installation, HolyCodex checks structured Codex CLI plugin state and attempts to install or enable the official `codex-security@openai-curated` plugin. This step is idempotent. HolyCodex prefers a Codex CLI on `PATH`; when it is absent, installation can reuse the active Bun executable or a supported npm/pnpm package runner. Authentication, catalog, marketplace, executable, timeout, package-runner, and other external availability failures are reported as non-fatal skip results, so HolyCodex installation still completes.

Codex manages curated Build Web Apps separately. Enable it through Codex before UI or frontend work. When available, HolyCodex routes that work to Frontend App Builder. In the project author's testing, Build Web Apps and Frontend App Builder produce the best results for visual taste. This is the author's assessment, not an OpenAI claim.

## Cleanup

```sh
npx holycodex cleanup
# or
bunx holycodex cleanup
```

Cleanup backs up affected state, removes HolyCodex-owned configuration and artifacts, and restores values replaced by managed Root and per-agent service-tier settings. Original permission values are restored when HolyCodex's generated selection remains active; a later user-selected permission mode remains user-owned. Unrelated user configuration is preserved. Codex Security is an independent official plugin, so cleanup does not remove or disable it. Install and cleanup are idempotent.

## Publishing

Pull requests to `main` run release validation. Pushes to `main` publish stable `latest` releases with npm trusted publishing. Protect `main`.

## Contributing

Repository layout:

- `packages/cli/`: public `holycodex` CLI.
- `packages/plugin/`: public `@holycodex/plugin` prompts, skills, agents, hooks, MCP metadata, and generated runtime.
- `packages/git-bash-mcp/`, `packages/lsp-*`, and `packages/mcp-stdio-core/`: internal portable runtimes.
- `test/`: lifecycle, configuration, instruction, protocol, and platform tests.

Source and published runtimes support Node.js and Bun. Use Vite+ for repository checks:

```sh
vp install
vp check --fix
vp test
```

`.github/workflows/publish.yml` publishes stable `latest` releases from `main` using npm trusted publishing.

## Credits and license

HolyCodex builds on work by YeonGyu Kim and the oh-my-openagent contributors, Julius Brussee and caveman contributors, and projects listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

HolyCodex uses the [Sustainable Use License 1.0](LICENSE.md). Third-party components retain their original licenses and notices.
