import process from "node:process";
import { cleanup, install, type RunOptions } from "./install.ts";

const VERSION = "0.5.3";
const HELP = `HolyCodex ${VERSION}\n\nUsage: holycodex <install|cleanup> [options]\n\nOptions:\n  --help                 Show help\n  --version              Show version\n  --no-tui               Accepted; commands are noninteractive\n  --codex-autonomous     Set autonomous Codex permissions (default)\n  --no-codex-autonomous  Preserve existing Codex permissions\n  --json                 Print machine-readable result\n`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.find((arg) => !arg.startsWith("--"));
  const options: RunOptions = {
    autonomous: !args.includes("--no-codex-autonomous"),
    json: args.includes("--json"),
  };
  const result =
    command === "install"
      ? await install(options)
      : command === "cleanup"
        ? await cleanup(options)
        : undefined;
  if (result === undefined) throw new Error(`Unknown command: ${command ?? ""}`);
  process.stdout.write(
    options.json ? `${JSON.stringify(result)}\n` : `HolyCodex ${result.action} complete.\n`,
  );
}

await main();
