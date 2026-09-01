// SPDX-License-Identifier: Apache-2.0

import { INSTALL_OPTION_CATALOG } from "./args.ts";

const TOP_LEVEL_HELP = `HolyCodex

Usage:
  holycodex install [options]
  holycodex doctor [options]
  holycodex cleanup --scope <run|workspace|expired> [options]
  holycodex version [<0.x.y|patch|minor>] [options]
  holycodex workflow <command> [options]

Options:
  --help, -h       Show this help.
  --version, -v    Print the canonical version.
  --json           Emit one validated JSON envelope.
  --no-tui         Disable prompts and interactive UI behavior.

Workflow execution uses one capability-denied QuickJS TypeScript evaluator. A
trusted TypeScript file must export a default workflow.wait(...) value. Use
workflow create for generated sources; stdin derives its objective from the
submitted workflow name and source unless --task overrides it.

Optional Work, Web, Security, Computer Use, LSP, LSP setup, and Git Bash
providers are independently capability-gated. Missing providers fail closed;
installation state does not claim provider availability.
`;

const WORKFLOW_HELP = `Workflow commands

Usage:
  holycodex workflow run <file.ts|-> [args.json] [options]
  holycodex workflow create <file.ts|-> [args.json] [--name <name>] [--session-id <id>]
  holycodex workflow check <file.ts> [options]
  holycodex workflow list [options]
  holycodex workflow show <run-id> [options]
  holycodex workflow inspect <run-id> [--follow] [options]
  holycodex workflow resume <run-id> <file.ts|-> [args.json] [options]
  holycodex workflow continuation <run-id> <file.ts|-> [args.json] [options]
  holycodex workflow goal <run-id> <summary> [options]
  holycodex workflow pause|restart|reopen|stop <run-id> [options]
  holycodex workflow stop-agent <run-id> <call-id> [options]
  holycodex workflow save <user|project> <name> <file.ts> [options]
  holycodex workflow invoke <user|project> <name> [args.json] [options]
  holycodex workflow refinement list|show|enable|disable ... [options]

Options:
  --plan <name>          Use an explicit validated plan.
  --tier <Standard|Fast> Use an explicit service tier.
  --fast                 Alias for --tier Fast.
  --autonomy <mode>      Select manual, assisted, or autonomous execution.
  --max-subagents <n>    Bound specialist concurrency.
  --trusted              Assert the caller has established project trust.
  --compat-quickjs       Deprecated one-release alias; the same evaluator is used.
  --task <objective>     Override the workflow-derived objective.
  --json, --no-tui       Select machine/non-interactive output behavior.

Workflow files must export a default workflow.wait(...) value. workflow check
performs type, import, schema, and security validation without host effects.
Workflow runs target the configured native {Role}.{task} dispatcher; the
generic App Server assignment path is an explicit compatibility fallback.
`;

const INSTALL_HELP = `Install HolyCodex through Codex native plugin management.

Usage:
  holycodex install [options]

Options:
${INSTALL_OPTION_CATALOG.map((option) => `  ${option.usage.padEnd(48)} ${option.description}`).join("\n")}

Positive and negative capability flags conflict with each other. HolyCodex
settings are persisted separately from Codex-owned plugin state.
`;

const DOCTOR_HELP = `Inspect owned configuration, Codex feature, tool, and
native plugin state without mutating it.

Usage:
  holycodex doctor [--json] [--no-tui]
`;

const CLEANUP_HELP = `Remove only an explicitly selected, resolved HolyCodex-owned scope.

Usage:
  holycodex cleanup --scope <run|workspace|expired|workflow-session> [--yes] [--json]
`;

const VERSION_HELP = `Read or update the canonical public package version.

Usage:
  holycodex version [<0.x.y|patch|minor>] [--dry-run] [--json]
  holycodex --version
  holycodex -v
`;

export function helpText(topic?: string): string {
  switch (topic) {
    case "install":
      return INSTALL_HELP;
    case "doctor":
      return DOCTOR_HELP;
    case "cleanup":
      return CLEANUP_HELP;
    case "version":
      return VERSION_HELP;
    case "workflow":
    case "workflow run":
    case "workflow create":
    case "workflow check":
    case "workflow list":
    case "workflow show":
    case "workflow inspect":
    case "workflow resume":
    case "workflow continuation":
    case "workflow goal":
    case "workflow pause":
    case "workflow restart":
    case "workflow reopen":
    case "workflow stop":
    case "workflow stop-agent":
    case "workflow save":
    case "workflow invoke":
    case "workflow refinement":
      return WORKFLOW_HELP;
    default:
      return TOP_LEVEL_HELP;
  }
}

export function helpRequested(argv: readonly string[]): boolean {
  return argv.some(
    (argument) => argument === "-h" || argument === "--help" || argument === "--help=true",
  );
}

export function helpTopic(argv: readonly string[]): string | undefined {
  const words = argv.filter((argument) => !argument.startsWith("-"));
  if (words[0] === "help") {
    return words[1] === "workflow" ? words.slice(1, 3).join(" ") || "workflow" : words[1];
  }
  if (words[0] === "--version" || words[0] === "version" || words[0] === "-v") {
    return "version";
  }
  if (words[0] === "workflow") {
    return words.slice(0, 2).join(" ") || "workflow";
  }
  return words[0];
}
