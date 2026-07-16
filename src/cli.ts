import process from "node:process";
import { doctor } from "./doctor.ts";
import { cleanup, install, type RunOptions } from "./install.ts";

const VERSION = "0.5.3";
const HELP = `HolyCodex ${VERSION}\n\nUsage: holycodex <install|cleanup|doctor> [options]\n\nOptions:\n  --help                          Show help\n  --version                       Show version\n  --no-tui                        Accepted; commands are noninteractive\n  --codex-autonomous              Never ask; keep workspace sandbox\n  --no-codex-autonomous           Safe interactive defaults (same as no flag)\n  --dangerous-codex-autonomous    Never ask; disable the sandbox\n  --json                          Print machine-readable result\n`;

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
  const autonomyFlags = args.filter((arg) =>
    ["--codex-autonomous", "--no-codex-autonomous", "--dangerous-codex-autonomous"].includes(arg),
  );
  if (autonomyFlags.length > 1)
    throw new Error(`Conflicting autonomy flags: ${autonomyFlags.join(", ")}`);
  const options: RunOptions = {
    autonomy: args.includes("--dangerous-codex-autonomous")
      ? "dangerous"
      : args.includes("--codex-autonomous")
        ? "autonomous"
        : "default",
    json: args.includes("--json"),
  };
  if (command === "doctor") {
    const result = await doctor();
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `${result.healthy ? "HolyCodex doctor: healthy" : "HolyCodex doctor: issues found"}\n${result.checks.map((item) => `${item.status.toUpperCase()} ${item.id}: ${item.detail}${item.fix === undefined ? "" : ` Fix: ${item.fix}`}`).join("\n")}\n`,
    );
    if (!result.healthy) process.exitCode = 1;
    return;
  }
  if (options.autonomy === "dangerous")
    process.stderr.write(
      "WARNING: dangerous autonomy disables approvals and filesystem sandboxing.\n",
    );
  else if (options.autonomy === "autonomous")
    process.stderr.write(
      "NOTICE: --codex-autonomous is now workspace-contained. Use --dangerous-codex-autonomous only for the former unrestricted behavior.\n",
    );
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
