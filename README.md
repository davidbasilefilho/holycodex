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

Root owns user interaction, scope, architecture, integration, and final verification. Explorer handles bounded repository discovery, Librarian handles current primary-source research, and Worker handles isolated implementation after Root fixes the contract.

Current routing values are:

| Plan        | Root                 | Explorer           | Librarian          | Worker               | Direct subagents |
| ----------- | -------------------- | ------------------ | ------------------ | -------------------- | ---------------: |
| `go`        | GPT-5.6 Terra medium | GPT-5.6 Terra low  | GPT-5.6 Terra low  | GPT-5.6 Terra medium |                0 |
| `plus-low`  | GPT-5.6 Sol low      | GPT-5.6 Luna high  | GPT-5.6 Luna high  | GPT-5.6 Luna high    |                1 |
| `plus`      | GPT-5.6 Sol medium   | GPT-5.6 Luna high  | GPT-5.6 Luna high  | GPT-5.6 Luna xhigh   |                2 |
| `plus-high` | GPT-5.6 Sol medium   | GPT-5.6 Luna xhigh | GPT-5.6 Luna xhigh | GPT-5.6 Luna xhigh   |                2 |
| `pro-5x`    | GPT-5.6 Sol high     | GPT-5.6 Luna xhigh | GPT-5.6 Luna xhigh | GPT-5.6 Luna xhigh   |                2 |
| `pro-20x`   | GPT-5.6 Sol high     | GPT-5.6 Luna xhigh | GPT-5.6 Luna xhigh | GPT-5.6 Luna xhigh   |                2 |

`plus` is the balanced default. It gives Root Sol medium for high-leverage decisions, gives Explorer and Librarian the quota-efficient Luna high route, and gives Worker the stronger Luna xhigh route. `plus-low` is the strict quota-efficiency option: its Root uses Sol low and all specialists use Luna high. `plus-high`, `pro-5x`, and `pro-20x` increase reasoning for Root, specialists, or both. `go` uses the Terra routes available to that plan.

The [DeepSWE v1.1 cost-performance analysis](docs/deepswe-v1.1.md) uses supplied costs that are already repriced for the July 30, 2026 GPT-5.6 changes. Luna high has the best measured cost per success among efforts allowed in active routing. Luna xhigh is the stronger delegated-work option while remaining inexpensive. Luna high beats Terra medium by 9.1 percentage points while costing about 67% less, and Luna xhigh costs about 82% less than Terra xhigh for only 3.3 percentage points less score. Terra is therefore mostly outside the current measured cost-performance frontier.

Sol remains useful for Root because Sol low through high requires roughly 51 to 53 expected agent steps per success, compared with roughly 111 to 125 for Luna high and xhigh. Root owns ambiguity resolution, architecture, integration, coordination, and final verification, so fewer loops can justify Sol's premium. Active subagents never use Sol, and no active route uses `max` reasoning.

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
holycodex install                              # Approve for me; workspace-write; network on
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

Codex Fast consumes exactly `2.5×` as much subscription usage as Standard. It changes latency and quota consumption, not benchmark quality or expected agent-step count. Fast is therefore a latency option, not the usage-efficiency default. HolyCodex writes the intended `service_tier` directly into Root and every generated agent-role configuration instead of relying on global inheritance.

Installation is noninteractive, backs up affected files, preserves unrelated configuration, and configures multi-agent support, selected agent capacity, specialist profiles, status context, and platform MCPs. Upgrading from the former global `--fast` behavior removes stale HolyCodex-managed global Fast state and writes deterministic Root and per-agent tiers for the selected mode. Dangerous autonomy remains explicit and is never inferred.

HolyCodex installs `holycodex-config` as an optional named permission profile with workspace access and networking. It does not select that profile through `default_permissions`, so users can switch to Full access or another built-in profile without HolyCodex forcing the desktop selection back. Legacy `approval_policy`, `approvals_reviewer`, and `sandbox_mode` fields provide installer-mode defaults:

| Installation mode                  | Approval policy | Reviewer      | Sandbox              |
| ---------------------------------- | --------------- | ------------- | -------------------- |
| Default or `--no-codex-autonomous` | `on-request`    | `auto_review` | `workspace-write`    |
| `--codex-autonomous`               | `never`         | unset         | `workspace-write`    |
| `--dangerous-codex-autonomous`     | `never`         | unset         | `danger-full-access` |

Bundled skills include explicit UI metadata and use the `HolyCodex: <Skill Name>` display brand, including `HolyCodex: LSP`, `HolyCodex: AST Grep`, and `HolyCodex: LSP Setup`.

During installation, HolyCodex checks structured Codex CLI plugin state and attempts to install or enable the official `codex-security@openai-curated` plugin. This step is idempotent. Authentication, catalog, marketplace, executable, timeout, and other external availability failures are reported as non-fatal skip results, so HolyCodex installation still completes.

Codex manages curated Build Web Apps separately. Enable it through Codex before UI or frontend work. When available, HolyCodex routes that work to Frontend App Builder. In the project author's testing, Build Web Apps and Frontend App Builder produce the best results for visual taste. This is the author's assessment, not an OpenAI claim.

## Cleanup

```sh
npx holycodex cleanup
# or
bunx holycodex cleanup
```

Cleanup backs up affected state, removes HolyCodex-owned configuration and artifacts, and restores values replaced by managed Root and per-agent service-tier settings. Unrelated user configuration is preserved. Codex Security is an independent official plugin, so cleanup does not remove or disable it. Install and cleanup are idempotent.

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
