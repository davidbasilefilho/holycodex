/** Current independent codexslimedit package version. */
export const CODEX_SLIM_EDIT_VERSION = "0.1.1";

/** Returns whether command-line arguments request the package version. */
export function isVersionRequest(args: readonly string[]): boolean {
  return args.includes("--version");
}
