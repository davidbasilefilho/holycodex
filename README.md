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

| Plan        | Root               | Explorer             | Librarian            | Worker               | Direct subagents |
| ----------- | ------------------ | -------------------- | -------------------- | -------------------- | ---------------- |
| `go`        | GPT-5.6 Sol low    | GPT-5.6 Luna low     | GPT-5.6 Luna low     | GPT-5.6 Terra low    | 0                |
| `plus-low`  | GPT-5.6 Sol medium | GPT-5.6 Luna low     | GPT-5.6 Luna medium  | GPT-5.6 Terra medium | 1                |
| `plus`      | GPT-5.6 Sol low    | GPT-5.6 Luna medium  | GPT-5.6 Terra low    | GPT-5.6 Terra high   | 2                |
| `plus-high` | GPT-5.6 Sol medium | GPT-5.6 Terra medium | GPT-5.6 Terra medium | GPT-5.6 Sol medium   | 2                |
| `pro-5x`    | GPT-5.6 Sol high   | GPT-5.6 Terra medium | GPT-5.6 Terra high   | GPT-5.6 Sol medium   | 2                |
| `pro-20x`   | GPT-5.6 Sol high   | GPT-5.6 Luna high    | GPT-5.6 Terra high   | GPT-5.6 Sol high     | 2                |

`plus` is the default plan.

All plans use subagent depth 1. The plan-selected direct subagent limit is emitted as `agents.max_threads`, which includes Root, so HolyCodex writes one more thread than the displayed value. Override it with `--max-subagents 0..3`.

```sh
holycodex install --plan plus-high
holycodex install --max-subagents 3
```

Explicit user model preferences are preserved during upgrades and cleanup.

## Platform behavior

| Platform        | MCP defaults                  | Shell behavior                                                                                      |
| --------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| Native Windows  | `git_bash`, `lsp`, `context7` | Shell actions use the allowlisted Git Bash bridge. Installation stops when Git Bash is unavailable. |
| Linux and macOS | `lsp`, `context7`             | Codex native shell tools remain active.                                                             |

HolyCodex restores native Codex workspace I/O. It does not install an editing MCP. Skills use native `apply_patch` and available native read or shell tools.

## Options

```sh
holycodex install                              # on-request, workspace-write, network on
holycodex install --plan <plan>
holycodex install --max-subagents <0..3>
holycodex install --codex-autonomous           # never ask, workspace-write, network on
holycodex install --dangerous-codex-autonomous # never ask, unrestricted host access
holycodex install --no-codex-autonomous        # contained default behavior
holycodex install --json
holycodex doctor [--json]
holycodex --help
holycodex --version
```

Dangerous autonomy is explicit and never inferred. Installation is noninteractive, backs up affected files, preserves unrelated configuration, and configures multi-agent support, selected agent capacity, specialist profiles, status context, and platform MCPs.

Installation also ensures the official `openai-curated` marketplace and installs `build-web-apps@openai-curated`. HolyCodex routes UI and frontend work to Frontend App Builder. In the project author's testing, Build Web Apps and Frontend App Builder produce the best results for visual taste. This is the author's assessment, not an OpenAI claim.

## Cleanup

```sh
npx holycodex cleanup
# or
bunx holycodex cleanup
```

Cleanup backs up affected state, removes HolyCodex-owned configuration and artifacts, and restores managed values. Install and cleanup are idempotent.

## Development channel

```sh
bunx holycodex@dev install
bunx holycodex@dev doctor
```

The `dev` tag tracks prereleases. Stable releases use `latest`.

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

`.github/workflows/publish.yml` publishes `dev` prereleases from `dev` and stable `latest` releases from `main` using npm trusted publishing. Protect both branches.

## Credits and license

HolyCodex builds on work by YeonGyu Kim and the oh-my-openagent contributors, Julius Brussee and caveman contributors, and projects listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

HolyCodex uses the [Sustainable Use License 1.0](LICENSE.md). Third-party components retain their original licenses and notices.
