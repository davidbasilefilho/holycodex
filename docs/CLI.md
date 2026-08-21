# HolyCodex CLI contract

This document is the single normative owner of command syntax, response
envelopes, exit codes, and TTY behavior. Runtime semantics are in
[BEHAVIOR.md](BEHAVIOR.md); package ownership is in [ARCHITECTURE.md](ARCHITECTURE.md).

The executable name is `holycodex`. Development invocation is
`mise exec -- bun packages/cli/src/index.ts ...`; the installed entry point has
the same command surface. `mise` selects the repository's Bun and TypeScript
toolchain. npm, pnpm, and yarn are not valid invocation routes.

## Commands

| Command                                                                                            | Required behavior                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `holycodex install [--yes] [--json]`                                                               | Validate the target and install only the owned HolyCodex scope. A mutation requires explicit confirmation; `--yes` is the non-interactive confirmation.                                                            |
| `holycodex doctor [--json]`                                                                        | Read-only inspection of toolchain, configuration, owned state, and capability availability. It does not repair or install.                                                                                         |
| `holycodex cleanup --scope <run\|workspace\|expired> [--yes] [--json]`                             | Preview or remove only the selected HolyCodex-owned scope. Active, ambiguous, or integrity-uncertain state is refused. Mutation requires `--yes`.                                                                  |
| `holycodex version <0.x.y\|patch\|minor> [--dry-run] [--json]`                                     | Read or update only the canonical public-package version.                                                                                                                                                          |
| `holycodex workflow run <file.ts\|-> [args.json] [--task <objective>] [--compat-quickjs] [--json]` | Start a validated workflow. Native files require a trusted default `workflow.wait(...)` export; `--compat-quickjs` explicitly selects the compatibility evaluator. Stdin requires compatibility mode and `--task`. |
| `holycodex workflow list [--json]`                                                                 | List sanitized HolyCodex-owned workflow runs.                                                                                                                                                                      |
| `holycodex workflow show <run-id> [--json]`                                                        | Return a sanitized durable run snapshot.                                                                                                                                                                           |
| `holycodex workflow inspect <run-id> [--follow] [--json]`                                          | Return operational progress without prompts, transcripts, or secrets.                                                                                                                                              |
| `holycodex workflow resume <run-id> <file.ts\|-> [args.json] [--json]`                             | Resume from the last valid checkpoint with explicitly resupplied source and arguments; both must match the stored digests.                                                                                         |
| `holycodex workflow goal <run-id> <summary> [--json]`                                              | Update the durable goal without changing authority or policy.                                                                                                                                                      |
| `holycodex workflow pause\|restart\|reopen\|stop <run-id> [--json]`                                | Apply the named lifecycle transition when valid.                                                                                                                                                                   |
| `holycodex workflow stop-agent <run-id> <call-id> [--json]`                                        | Stop one active specialist call without granting a retry.                                                                                                                                                          |
| `holycodex workflow save <user\|project> <name> <file.ts> [--json]`                                | Save a trusted TypeScript workflow in HolyCodex-owned state.                                                                                                                                                       |
| `holycodex workflow invoke <user\|project> <name> [args.json] [--json]`                            | Invoke a saved workflow after identity and trust validation.                                                                                                                                                       |
| `holycodex workflow refinement list\|show\|enable\|disable ... [--json]`                           | Inspect or explicitly activate typed, scoped refinement records.                                                                                                                                                   |

Unknown commands, missing required arguments, malformed values, and invalid
combinations are usage failures. Options are explicit; a command never turns
an absent option into permission to broaden scope.

## Response envelopes

Every invocation has one machine envelope. In JSON mode, stdout contains one
UTF-8 JSON object followed by one newline and nothing else; logs, progress,
and diagnostics go to stderr. ANSI control sequences, prompts, and secrets do
not appear in JSON output.

Success:

```json
{
  "schema_version": "0.15",
  "ok": true,
  "command": "doctor",
  "data": {},
  "warnings": []
}
```

Failure:

```json
{
  "schema_version": "0.15",
  "ok": false,
  "command": "doctor",
  "error": {
    "code": "stable_machine_code",
    "message": "human-readable summary",
    "details": {}
  },
  "warnings": []
}
```

`schema_version`, `ok`, and `command` are always present. Success has
`data`; failure has `error.code`, `error.message`, and `error.details`.
`warnings` is always an array. Details are sanitized and bounded. Effect Schema
from `effect/Schema` owns the envelope definitions and validation helpers used
at every receiving boundary.

Human mode may format the same result for a TTY, but it does not change the
underlying command result, state transition, or exit code. `--json` forces
machine behavior even when stdout is a TTY.

## Exit codes

| Code | Meaning                                                    | Example machine error codes                                            |
| ---: | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
|  `0` | Successful command                                         | `ok`                                                                   |
|  `1` | Usage or input validation failure                          | `unknown_command`, `invalid_argument`, `non_tty_confirmation_required` |
|  `2` | Capability, permission, or environment denial              | `capability_denied`, `toolchain_unavailable`, `permission_denied`      |
|  `3` | Operational failure with a classified unsuccessful outcome | `install_failed`, `cleanup_failed`, `run_failed`                       |
|  `4` | Integrity or security fail-closed stop                     | `state_corrupt`, `effect_uncertain`, `trust_boundary_failed`           |
|  `5` | Unexpected internal failure                                | `internal_error`                                                       |

The process uses the lowest applicable code for the command outcome; an error
envelope is still emitted when output can be safely produced. A nonzero exit
never means that a requested external effect succeeded.

## TTY and non-TTY rules

TTY mode may show progress and may ask for confirmation only for a
non-destructive, explicitly scoped operation. Non-TTY mode never prompts,
waits for a human, opens a browser, or guesses an answer. A mutation that
needs confirmation must receive `--yes`; otherwise it returns
`non_tty_confirmation_required` with exit `1`. `--json` is always
non-interactive, even on a TTY.

Workflow-run task text in non-TTY use must be supplied with `--task` when the
source is stdin. Explicit files use only their deterministic basename default
when `--task` is omitted; resume always names its source explicitly. End of
input is a validation failure, not a prompt. Native workflow execution is the
default and requires a trusted TypeScript file exporting a default
`workflow.wait(...)` value. `--compat-quickjs` is explicit compatibility
behavior; it never becomes the native default. Optional Work, Web, Security,
Computer Use, LSP, LSP setup, and Git Bash providers are capability-gated.
Missing or unavailable providers return `capability_denied` with exit code `2`;
selection state does not imply a live provider.
The CLI does not read arbitrary environment values into output or state.
Signals and cancellation produce a structured unsuccessful outcome when the
process can emit one; state recovery follows [SECURITY.md](SECURITY.md).

## Command-specific safety

`install` validates its target, toolchain, and owned scope before mutation and
does not install MCP servers. Official optional-plugin mutation occurs only
after core activation is verified; desired state is journaled, failures remain
uncertain, and doctor reports disagreement without claiming rollback.
`doctor` is read-only. `cleanup`
requires a named scope, never follows an unresolved broad path, and refuses
active or uncertain state. Workflow lifecycle commands require an existing
run identity. Inspection and replay projections have no effect capability.
The detailed trust and recovery boundary is owned by [SECURITY.md](SECURITY.md).
