// SPDX-License-Identifier: Apache-2.0

import { INSTALL_OPTION_CATALOG } from "./args.ts";
import type { HumanRenderOptions } from "./types.ts";

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

Profiles control routing only:
  low     Root gpt-6-astra/low; specialists use the low Luna matrix.
  default Root gpt-6-astra/medium; recommended default routing.
  high    Root gpt-6-astra/high; specialists use the high Luna matrix.
  Default profile: default.

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
On an interactive TTY, install opens one wizard and final review with Install,
Change options / Redo, and Cancel. The wizard never asks for CODEX_HOME.
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

/** Render human help with restrained terminal color; JSON callers use helpText. */
export function renderHelp(topic?: string, options: HumanRenderOptions = {}): string {
  const color = colorEnabled({ ...options, stream: "stdout" });
  return helpText(topic)
    .split("\n")
    .map((line) => {
      if (line === "HolyCodex") return paint(line, "heading", color);
      if (
        /^(?:Usage|Options|Profiles control routing only|Tier is independent service handling|Capability defaults).*:$/u.test(
          line,
        )
      ) {
        return paint(line, "heading", color);
      }
      return line
        .replace(/--[a-z][a-z0-9-]*/gu, (option) => paint(option, "option", color))
        .replace(/<[^>]+>/gu, (argument) => paint(argument, "argument", color));
    })
    .join("\n");
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

export function colorEnabled(options: HumanRenderOptions): boolean {
  const env = options.env ?? {};
  if (env["NO_COLOR"] !== undefined || env["TERM"] === "dumb") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  if (env["CI"] !== undefined && env["CI"] !== "false") return false;
  const tty = options.stream === "stderr" ? options.stderrIsTTY : options.stdoutIsTTY;
  return tty === true;
}

type HelpColor = "heading" | "option" | "argument";

function paint(value: string, color: HelpColor, enabled: boolean): string {
  if (!enabled) return value;
  const codes: Record<HelpColor, string> = { heading: "1", option: "36", argument: "2" };
  return `\u001b[${codes[color]}m${value}\u001b[0m`;
}
