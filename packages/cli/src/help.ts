// SPDX-License-Identifier: Apache-2.0

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

Workflow execution is native Effect workflow-module execution by default. A
trusted TypeScript file must export a default workflow.wait(...) value. The
explicit --compat-quickjs flag selects the compatibility-only string evaluator;
stdin requires that flag and an explicit --task objective.

Optional Work, Web, Security, Computer Use, LSP, LSP setup, and Git Bash
providers are independently capability-gated. Missing providers fail closed;
installation state does not claim provider availability.
`;

const WORKFLOW_HELP = `Workflow commands

Usage:
  holycodex workflow run <file.ts|-> [args.json] [options]
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
  --compat-quickjs       Explicitly select the string/QuickJS compatibility path.
  --task <objective>     Required for native-unsupported stdin compatibility runs.
  --json, --no-tui       Select machine/non-interactive output behavior.

Native workflow files must export a default workflow.wait(...) value. The
compatibility evaluator is never selected implicitly; use --compat-quickjs.
`;

const INSTALL_HELP = `Install HolyCodex into the owned scope.

Usage:
  holycodex install --yes [--json] [--plan <name>] [--tier <Standard|Fast>]

Installation preserves unrelated configuration and does not install MCP
servers. Optional provider selections are recorded as desired state only; a
provider is available only when an invocation port is configured.
`;

const DOCTOR_HELP = `Inspect owned installation, migration, payload, lock,
tool, and optional-plugin state without mutating it.

Usage:
  holycodex doctor [--json] [--no-tui]
`;

const CLEANUP_HELP = `Remove only an explicitly selected, resolved HolyCodex-owned scope.

Usage:
  holycodex cleanup --scope <run|workspace|expired> [--yes] [--json]
`;

const VERSION_HELP = `Read or update the canonical public package version.

Usage:
  holycodex version [<0.x.y|patch|minor>] [--dry-run] [--json]
  holycodex --version
  holycodex -v
`;

export function helpText(topic: string | undefined = undefined): string {
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
