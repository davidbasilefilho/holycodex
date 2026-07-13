# HolyCodex

HolyCodex is a modified, standalone Codex-only hard fork of [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). It keeps the parts that make Codex better at software work, removes the OpenCode runtime and organizational agent machinery, and compresses persistent instructions for lower ChatGPT Plus usage.

## What

HolyCodex installs one focused Codex toolkit:

- 18 on-demand skills for programming, debugging, frontend, LSP, AST search, TDD, security research, planning, handoffs, goal definition, compression, and related workflows.
- Three optional subagents: `explorer` for internal inspection, `librarian` for external research, and `worker` for bounded implementation.
- Four MCP defaults: `git_bash`, `lsp`, `grep_app`, and `context7`.
- Small command hooks for readiness and scoped rules.
- A Node-compatible installer and prebuilt runtime usable through npm or Bun.

The primary agent always owns the task and decisions. Subagents exist only to reduce cost on narrow independent work—not to simulate an organization.

## Why

Large always-on prompts, agent hierarchies, review loops, and duplicated context consume tokens before useful work begins. HolyCodex takes a smaller approach:

- Skills load only when their descriptions match the task.
- Descriptions explain both what each capability does and when to use it.
- Rules are path-scoped, size-limited, cached, and deduplicated; `AGENTS.md` is never reinjected.
- Delegation is capped at two and remains under primary-agent control.
- Sol and Terra use low or medium reasoning; Luna may also use high.
- OMO workflows and retained references are rewritten with caveman-style token efficiency.
- The OMO frontend skill is merged with GPT Taste instead of shipping another overlapping skill.

The result aims to keep strong engineering behavior while spending fewer Plus tokens on ceremony and repeated instructions.

## How

### Install

Use either runtime:

```sh
npx holycodex install
bunx holycodex install
```

Installation is noninteractive. It:

1. Backs up every affected existing file or managed cache under the OS temporary directory.
2. Removes legacy OMO configuration and cache after backup.
3. Preserves unrelated Codex settings and explicit model or agent preferences.
4. Installs the HolyCodex marketplace, plugin, agents, skills, hooks, and MCP definitions.
5. Sets `max_concurrent_threads_per_session = 2` and defaults the root model to GPT-5.6 Sol low only when no root preference exists.

Codex may still ask you to review and trust the installed command hooks. This security review is the only manual installation step.

Options:

```sh
holycodex install --json
holycodex install
holycodex --help
holycodex --version
```

### Cleanup

```sh
npx holycodex cleanup
# or
bunx holycodex cleanup
```

Cleanup backs up affected files, removes only HolyCodex-owned configuration and artifacts, and preserves unrelated settings. Install and cleanup are idempotent.

### Repository layout

- `plugin/skills/` — shipped skill catalogue and on-demand references.
- `plugin/agents/` — the three cost-focused subagent definitions.
- `plugin/hooks/` — supported command hooks for readiness and scoped rules.
- `plugin/.mcp.json` — local and remote MCP defaults.
- `plugin/runtime/` — prebuilt Node-compatible CLI, rules, Git Bash, and LSP runtime.
- `src/` — installer, cleanup, bootstrap, and scoped-rules source.
- `packages/` — Git Bash and LSP MCP source.
- `test/` — CLI, lifecycle, catalogue, rules, bootstrap, and MCP tests.

## Thanks

HolyCodex exists because of the work of:

- [YeonGyu Kim and the oh-my-openagent contributors](https://github.com/code-yeongyu/oh-my-openagent), whose project, history, workflows, and Codex integrations form the foundation of this hard fork.
- [Julius Brussee and caveman contributors](https://github.com/JuliusBrussee/caveman), for the token-efficient communication approach adapted here.
- The authors credited in [`plugin/skills/frontend/ATTRIBUTION.md`](plugin/skills/frontend/ATTRIBUTION.md), whose frontend design, performance, and UI/UX resources remain attributed under their original terms.
- Every upstream library and tool author whose work is preserved in the Git history and third-party notices.

## Licenses

HolyCodex uses the same [Sustainable Use License 1.0](LICENSE.md) as oh-my-openagent. This is not the MIT License: use and distribution are subject to the limitations in `LICENSE.md`.

Third-party components retain their original licenses. Relevant notices and bundled license files are preserved in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and alongside the applicable skills or components.
