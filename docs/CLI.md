# HolyCodex CLI contract

This document owns command syntax, response envelopes, exit codes, and
confirmation behavior. Observable product behavior is in
[BEHAVIOR.md](BEHAVIOR.md); package placement is in
[ARCHITECTURE.md](ARCHITECTURE.md); installation ownership is in
[INSTALLATION.md](INSTALLATION.md).

The executable is `holycodex`. The published entry point is invoked with
`bunx`; development uses `mise exec -- bun packages/cli/src/index.ts ...`.
Bun is the repository runtime/toolchain. The canonical install and removal
commands are `bunx holycodex install` and `bunx holycodex remove`.

## Commands

| Command                                                              | Required behavior                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `holycodex install [options]`                                        | Validate input, configure the selected profile, tier, and optional plugins through Codex native plugin management, verify readback, and write owned configuration. |
| `holycodex doctor [--json]`                                          | Compare effective Root config, canonical leaf registrations/files, selected capabilities, ownership, and transaction state.                                        |
| `holycodex remove [--yes] [--json]`                                  | Verify ownership, remove HolyCodex's native plugin state, and remove its owned configuration without touching unrelated state.                                     |
| `holycodex version [<0.x.y[-n]\|patch\|minor>] [--dry-run] [--json]` | Read or update the canonical package version.                                                                                                                      |
| `holycodex --help`                                                   | Print the current command and option syntax.                                                                                                                       |

Installation options are `--yes`, `--profile <name>`,
`--tier <name>`, `--frontend`, `--security`, `--computer-use`, and
`--add-plugin <id>`, and `--json`. Interactive plugin entry accepts whitespace-separated IDs. Each option is explicit; conflicting or
malformed values fail before any effect.

Profiles select native subagent routing only. The tier is an independent
service setting. A selected capability and every additional plugin must install
and verify as installed and enabled; otherwise installation returns
`capability_denied` or a classified installation failure without claiming
success. The default selections are Frontend and Security; Computer Use
remains disabled unless selected.

Root's selected model, reasoning effort, service tier, compact developer
instructions, required feature flags, and every canonical leaf registration
are managed in `config.toml`. The parent session is Root; HolyCodex never
creates or registers `agents/root.toml`. Native leaf profiles encode
`standard` as `service_tier = "default"`; `fast` keeps Root on `default` and
sets leaves to `fast`; `fast-all` sets both Root and leaves to `fast`. Leaf
TOMLs omit `tool_output_token_limit` and use native sandbox, approval, network,
and delegation-feature controls.

Live profiles select configured Root and specialist route identities and the
per-task effort matrix owned by [BEHAVIOR.md](BEHAVIOR.md). All generated
instructions target GPT-6-family behavior; temporary route IDs are not
instruction semantics. Historical route and profile values are migration-only.

With `--computer-use`, the official Computer Use capability is installed and
Root receives the conditional Root-only interactive execution directive. The
directive is absent without that option and the capability is unavailable; it
is never represented as delegateable work or a delegation fallback. Native
configuration withholds GUI, browser, and Computer Use from every leaf.

Official OpenAI plugin health accepts the allowlisted `openai-curated` and
`openai-curated-remote` identities for build-web-apps and codex-security. An
arbitrary same-name plugin from another marketplace is not accepted.

Valid profile names are `low`, `default`, and `high`; `default` is
recommended. Existing serialized `plan` fields migrate losslessly to
`profile`. Legacy `plus-low`, `plus`, and `plus-high` values migrate to
`low`, `default`, and `high`. Legacy `go` is recognized and requires an
explicit replacement; removed `pro-5x` and `pro-20x` values are classified as
legacy and require an explicit replacement. These values are migration-only,
not live profiles.
Valid tier names are `standard`, `fast`, and `fast-all`; select them through
`--tier`.

## Agent CLI

`holycodex-agent` is a separate deterministic model-facing CLI. It has no TUI,
prompts, or ANSI output and emits stable structured responses. It is the only
normal mutation interface for repo-local `.holycodex/` Intent, Plan, and
Assignment state; it does not replace the public human CLI.

```text
holycodex-agent intent   create|list|current|read|select|transition|evidence|complete|abandon
holycodex-agent plan     read|revise
holycodex-agent assignment create|list|read|revise|supersede|start|recover|result
holycodex-agent state diagnose --intent <ref> [--repo <path>]
```

Every command and nested subcommand accepts equivalent `-h` and `--help`,
exits 0 without mandatory arguments or side effects, and documents its input,
output, effects, and important failure conditions. Semantic operations validate
all request and persisted values and return deterministic error codes. Agents
must not rename or edit TOON files directly.

`state diagnose` inspects the referenced Intent, its active Plan and
Assignments, and the repository baseline. It returns `intent_id` and
deterministic issues with a code, subject, and repair guidance for broken
`assignment-*` references, inconsistent relationships, unfinished work, missing
completion evidence, or repository drift. It does not recover transactions,
acquire locks, or change persisted records.

Root's delegation, authority, review, and release boundaries are defined in
[BEHAVIOR.md](BEHAVIOR.md). Workflow Plan approval and installation profile
approval remain distinct from routing choices. Unresolved material input is
recorded as `needs_root_input` in the relevant Intent or Plan; existing user
authorization is retained.

## Response envelopes

JSON mode writes exactly one UTF-8 object followed by one newline to stdout.
Progress and diagnostics go to stderr. ANSI control sequences, prompts, and
secrets do not appear in JSON output.

Success and failure share the same stable fields:

```json
{
  "schema_version": "<current>",
  "ok": true,
  "command": "install",
  "data": {},
  "warnings": []
}
```

Failures set `ok` to `false` and provide `error.code`, `error.message`, and
bounded `error.details`. `warnings` is always an array. Effect Schema from
`effect/Schema` owns envelope validation at the receiving boundary.

## Exit codes and confirmation

| Code | Meaning                                       |
| ---: | --------------------------------------------- |
|  `0` | Successful command                            |
|  `1` | Usage or input validation failure             |
|  `2` | Capability, permission, or environment denial |
|  `3` | Classified installation or removal failure    |
|  `4` | Integrity or security fail-closed stop        |
|  `5` | Unexpected internal failure                   |

Mutating commands require `--yes` when confirmation cannot be collected.
JSON mode is always non-interactive. A nonzero exit never means that an
external effect succeeded. An uncertain effect is reported and preserved for
Root or user resolution; it is not blindly repeated.

Install reconciliation and removal report modified, provably owned state as
resolvable conflicts. Interactive resolution exposes the path or key and proposed action:
accept, decline/preserve, or cancel. `--yes` accepts owned replacement/removal;
JSON or non-TTY without it returns structured confirmation-required state.
`--dry-run` is available only with `version`; it reports the prospective
canonical version change without writing. Foreign or unverifiable state is
never offered for destructive resolution.

## Human output

Without `--json`, install, remove, and doctor report concise semantic results.
Install reports the version, profile, tier, selected capabilities, preserved
state, and actionable warnings. Remove reports owned state removed or
preserved. Doctor reports health and checks that need attention. Human output
does not print the internal installation record. Progress is written to stderr
on an interactive terminal.

`holycodex -v` and `holycodex --version` print one line:

```text
holycodex <version>
```

Help colors headings, options, and arguments on interactive non-CI terminals.
`NO_COLOR`, CI environments, and non-TTY output receive plain text. JSON mode
always emits one validated envelope and never includes ANSI, prompts, progress,
or secrets.

Interactive forms use ↑/↓ for navigable items, Space for focused toggles, and
←/→ for choices. Enter submits or accepts the form, including proceeding from
install configuration to review; it never advances focus. Esc cancels or goes
back at the current boundary. Text fields retain normal editing controls.
Color distinguishes focus, state, status, sections, and hints alongside text
indicators; `NO_COLOR` and non-TTY output remain ANSI-free.
