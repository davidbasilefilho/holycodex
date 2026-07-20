/** The action requested by CodexSlimEdit command-line arguments. */
export type CliAction = "start" | "version" | "help";

/** Concise help text for the CodexSlimEdit command-line entrypoint. */
export const CLI_HELP = "Usage: codexslimedit [--version|-v] [--help|-h]";

/** Resolves supported command-line options while preserving MCP startup by default. */
export function getCliAction(args: readonly string[]): CliAction {
  if (args.includes("--version") || args.includes("-v")) {
    return "version";
  }
  if (args.includes("--help") || args.includes("-h")) {
    return "help";
  }
  return "start";
}
