# HolyCodex

HolyCodex installs plan-aware dynamic workflows for Codex with isolated agents, scoped engineering skills, live web search, Context7 documentation lookup, LSP code intelligence, and safe Git Bash execution on native Windows. HolyCodex installs and manages zero MCP servers.

## Install

```bash
bunx holycodex install
```

Restart Codex after installation. Verify the result with:

```bash
bunx holycodex doctor
```

Installation is transactional. Assets are generated and validated in staging before replacement. Failed upgrades restore the prior usable state. Successful upgrades remove obsolete HolyCodex version caches and retain five timestamped recovery backups under the operating-system temporary directory.

## Plans

Plans are ordered by available usage: `go`, `plus-low`, `plus`, `plus-high`, `pro-5x`, and `pro-20x`. `plus` is the default recommendation. Use `--plan <name>`. The legacy `--max-subagents` flag remains accepted during migration but dynamic workflow quotas are plan-authoritative.

Fast modes are explicit: `--fast` applies Fast to specialists, `--fast-all` includes Root, and `--no-fast` selects standard service tiers. Preserved Root and specialist model, reasoning, service-tier, and custom settings are healthy overrides rather than installation errors.

## Dynamic workflows

For substantive requests, Root writes task-specific JavaScript with `agent()`, `pipeline()`, structured `args`, and ordinary control flow. The script can discover work dynamically, branch, retry, fan out, loop until checks pass or progress stalls, run adversarial verification, and synthesize a coordinated result. Multiple workflows may be used for discovery, implementation, and verification.

Workflow JavaScript runs in a capability-denied runtime with no direct filesystem, shell, process, environment, network, import, configuration, or credential access. Agents perform authorized work through Codex and inherit its sandbox, approvals, tools, skills, plugins, trust rules, and project boundaries. Plan-specific hard limits bound concurrency, calls, depth, retries, loops, fan-out, projected usage, and runtime.

Normal conversation receives concise progress and the final result. Explicit inspection can show scripts and operational state, but never hidden reasoning, system prompts, credentials, or unrestricted child transcripts.

Essential installation flags include `--codex-autonomous`, `--no-codex-autonomous`, `--dangerous-codex-autonomous`, `--json`, and the plan and Fast flags above. `doctor` and `cleanup` accept only `--json`.

## Integrations

The bundled Context7 CLI skill runs `ctx7@latest` directly through the first available runner in this order: nub, Bun, pnpm, npm, then Yarn. It uses current documentation without global installation, authentication, API keys, or MCP configuration.

The bundled LSP skill calls `node runtime/lsp.js` for status, diagnostics, definition, declaration, references, document or workspace symbols, prepare rename, and rename. Its daemon is started and reused automatically.

On native Windows, installed prompts require every shell command to use `node runtime/git-bash.js --cwd <directory> --command <script>`. The launcher resolves Git for Windows, runs `bash.exe -lc`, preserves process I/O and exit status, and terminates timed-out process trees. Other platforms use their native shell.

## Cleanup

```bash
bunx holycodex cleanup
```

Cleanup removes only HolyCodex-managed assets and restores managed values when they remain unchanged. Later user edits and unrelated configuration, permissions, plugins, and independently configured MCP servers are preserved.

## Documentation

- [Configuration](docs/CONFIGURATION.md)
- [Integrations](docs/INTEGRATIONS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Routing](docs/ROUTING.md)
- [Releasing](docs/RELEASING.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Security](docs/SECURITY.md)
- [Changelog](docs/CHANGELOG.md)

HolyCodex is derived from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). Additional credits and preserved licenses are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Licensed under [SUL-1.0](LICENSE.md).
