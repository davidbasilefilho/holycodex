// SPDX-License-Identifier: Apache-2.0

import { INSTALL_OPTION_CATALOG } from "./args.ts";

const TOP_LEVEL_HELP = `HolyCodex

Usage:
  holycodex install [options]
  holycodex remove [options]
  holycodex doctor [options]
  holycodex version [<0.x.y|patch|minor>] [options]

Options:
  --help, -h       Show this help.
  --version, -v    Print the canonical version.
  --json           Emit one validated JSON envelope.

Use --json for scripts. Install and remove use native Codex plugin management.
`;

const INSTALL_HELP = `Install HolyCodex through Codex native plugin management.

Usage:
  holycodex install [options]

Plans control routing only:
  Go       Root gpt-5.6-terra/high; leaves use plus-low Luna route efforts.
  plus-low Root gpt-5.6-sol/low; leaves use plus-low Luna route efforts.
  plus    Root gpt-5.6-sol/medium; leaves use plus Luna route efforts.
  plus-high, pro-5x Root gpt-5.6-sol/high; each keeps its Luna route efforts.
  pro-20x Root gpt-5.6-sol/xhigh; leaves use pro-20x Luna route efforts.
  Default plan: plus.

Tier is independent service handling (CLI values are lowercase only):
  standard  Standard service handling (default).
  fast      Fast service handling; it does not change routing.
  fast-all  Fast service handling for Root and leaves.

Options:
${INSTALL_OPTION_CATALOG.map((option) => `  ${option.usage.padEnd(48)} ${option.description}`).join("\n")}
  --no-work / --no-frontend / --no-security /
  --no-computer-use                         Disable the corresponding plugin.
  --codex-home <absolute-path>              Use an isolated Codex home.

Capability defaults: Work false, Frontend true (mapped to build-web-apps),
Security true, and Computer Use false. --add-plugin may be repeated.
`;

const REMOVE_HELP = `Remove HolyCodex-owned state through Codex native plugin management.

Usage:
  holycodex remove [--yes] [--json] [--codex-home <absolute-path>]

Only HolyCodex-owned state is removed. Shared and unrelated Codex plugins and
configuration are preserved; changed owned files are preserved for review.
`;

const DOCTOR_HELP = `Inspect HolyCodex-owned configuration and native plugin state without mutating it.

Usage:
  holycodex doctor [--json] [--codex-home <absolute-path>]
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
    case "remove":
      return REMOVE_HELP;
    case "doctor":
      return DOCTOR_HELP;
    case "version":
      return VERSION_HELP;
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
  if (words[0] === "help") return words[1];
  if (words[0] === "--version" || words[0] === "version" || words[0] === "-v") return "version";
  return words[0];
}
