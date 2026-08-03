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

| Plan        | Root               | Explorer          | Librarian         | Worker             | Direct subagents |
| ----------- | ------------------ | ----------------- | ----------------- | ------------------ | ---------------: |
| `go`        | GPT-5.6 Luna high  | GPT-5.6 Luna high | GPT-5.6 Luna high | GPT-5.6 Luna high  |                0 |
| `plus-low`  | GPT-5.6 Sol low    | GPT-5.6 Luna high | GPT-5.6 Luna high | GPT-5.6 Luna high  |                2 |
| `plus`      | GPT-5.6 Sol medium | GPT-5.6 Luna high | GPT-5.6 Luna high | GPT-5.6 Luna high  |                2 |
| `plus-high` | GPT-5.6 Sol medium | GPT-5.6 Luna high | GPT-5.6 Luna high | GPT-5.6 Luna xhigh |                2 |
| `pro-5x`    | GPT-5.6 Sol high   | GPT-5.6 Luna high | GPT-5.6 Luna high | GPT-5.6 Luna xhigh |                2 |
| `pro-20x`   | GPT-5.6 Sol high   | GPT-5.6 Luna high | GPT-5.6 Luna high | GPT-5.6 Luna max   |                2 |

`plus` is the balanced default. It gives Root Sol medium and all specialists Luna high. `plus-high` and `pro-5x` raise Worker to Luna xhigh; `pro-20x` raises Worker to Luna max. `go` uses Luna high for every role.

The [model routing policy](docs/ROUTING.md) documents the exact routes, capability floors, 80/20 weighted criterion, Standard benchmark data, and projected Fast data.

Routing applies practical capability floors, then weights relative cost per success at 80% and relative cost per task at 20%. Paid-plan Root uses Sol because orchestration, architecture, integration, and final judgment affect the entire workflow. Active subagents use Luna.

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

Codex Fast consumes `2×` the API-equivalent usage of Standard. Published throughput exceeds 100 output tokens/s for Luna, 70 for Terra, and 80 for Sol; Sol may be up to `2.5×` faster than Standard. Fast is a latency option independent of routing. HolyCodex changes only `service_tier`, never model routing or reasoning effort.

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

Pull requests validate release artifacts. Every push to `main` publishes a unique `dev` prerelease. Only an exact annotated `v<version>` tag publishes a stable `latest` release. The plugin always publishes before the CLI, and npm trusted publishing uses GitHub OIDC with provenance. The workflow never uses an npm token, overwrites a version, or unpublishes a package.

Prepare a stable release from a clean tree. The version command synchronizes every tracked version surface, but it does not publish anything by itself. A nonempty first command is a stop condition. The dry run makes no changes.

```sh
git status --short
bun scripts/version.mjs patch --dry-run
bun scripts/version.mjs patch # or: minor, or an explicit 0.x.y
bunx vp install --frozen-lockfile
bunx vp check --fix
bunx vp test
bunx vp run build
bun scripts/version.mjs check
git diff --check
git status --short
git diff --stat # Confirm the synchronized release changes before committing.
git commit -am "release: v<version>"
git tag -a v<version> -m "v<version>"
git push origin main --follow-tags
```

Observe the `Publish to npm` workflow. Verify both exact versions and their tags with `npm view @holycodex/plugin@<version> version dist-tags --json` and `npm view holycodex@<version> version dist-tags --json`, then verify the GitHub release. If a tagged stable run needs recovery, use `workflow_dispatch` with `ref=refs/tags/v<version>`, `stable=true`, and the default `dry_run=true`; change `dry_run` to `false` only after that validation succeeds. The recovery path shares the stable implementation and only skips an existing version when its local and registry integrities match.

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

`.github/workflows/publish.yml` validates pull requests, publishes `dev` prereleases from `main`, and publishes stable `latest` releases only from exact version tags using npm trusted publishing.

## Credits and license

HolyCodex builds on work by YeonGyu Kim and the oh-my-openagent contributors, Julius Brussee and caveman contributors, and projects listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

HolyCodex uses the [Sustainable Use License 1.0](LICENSE.md). Third-party components retain their original licenses and notices.
