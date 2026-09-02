# HolyCodex CLI contract

This document owns command syntax, response envelopes, exit codes, and
confirmation behavior. Observable product behavior is in
[BEHAVIOR.md](BEHAVIOR.md); package placement is in
[ARCHITECTURE.md](ARCHITECTURE.md); installation ownership is in
[INSTALLATION.md](INSTALLATION.md).

The executable is `holycodex`. The published entry point is invoked with
`bunx`; development uses `mise exec -- bun packages/cli/src/index.ts ...`.
Bun is the only repository toolchain.

## Commands

| Command                                                          | Required behavior                                                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `holycodex install [options]`                                    | Validate input, configure the selected plan, tier, and optional plugins through Codex native plugin management, verify readback, and write owned configuration. |
| `holycodex remove [--yes] [--json]`                              | Verify ownership, remove HolyCodex's native plugin state, and remove its owned configuration without touching unrelated state.                                  |
| `holycodex version [<0.x.y\|patch\|minor>] [--dry-run] [--json]` | Read or update the canonical package version.                                                                                                                   |
| `holycodex --help`                                               | Print the current command and option syntax.                                                                                                                    |

Installation options are `--yes`, `--plan <name>`,
`--tier <name>`, `--work`, `--frontend`, `--security`, `--computer-use`, and
`--add-plugin <id>`, and `--json`. Each option is explicit; conflicting or
malformed values fail before any effect.

Plans select native subagent routing only. The tier is an independent service
setting. Explicit optional selections and additional plugins return
`capability_denied` when unavailable. An unavailable implicit frontend or
Security first-install default is recorded as `missing` or `uncertain`, emits
a warning, and remains selected for retry on reinstall.

Native profiles encode `standard` as `service_tier = "default"` for Root and
leaves. `fast` keeps Root on `default` and sets leaves to `fast`; `fast-all`
sets both Root and leaves to `fast`.

Valid plan names are `Go`, `plus-low`, `plus`, `plus-high`, `pro-5x`, and
`pro-20x`.
Valid tier names are `standard`, `fast`, and `fast-all`; select them through
`--tier`.

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
