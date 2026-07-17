import process from "node:process";
import { VERSION } from "./catalog.ts";
import { doctor } from "./doctor.ts";
import { cleanup, install, type RunOptions } from "./install.ts";
import {
  renderDoctor,
  renderError,
  renderHelp,
  renderNotice,
  renderRunResult,
  supportsColor,
} from "./presentation.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stdoutColor = supportsColor(process.stdout.isTTY, process.env.NO_COLOR);
  const stderrColor = supportsColor(process.stderr.isTTY, process.env.NO_COLOR);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(renderHelp(VERSION, stdoutColor));
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.find((arg) => !arg.startsWith("--"));
  const autonomyFlags = args.filter((arg) =>
    ["--codex-autonomous", "--no-codex-autonomous", "--dangerous-codex-autonomous"].includes(arg),
  );
  if (autonomyFlags.length > 1) {
    process.stderr.write(
      renderError(`Conflicting autonomy flags: ${autonomyFlags.join(", ")}`, stderrColor),
    );
    process.exitCode = 1;
    return;
  }
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
      options.json ? `${JSON.stringify(result)}\n` : renderDoctor(result, stdoutColor),
    );
    if (!result.healthy) process.exitCode = 1;
    return;
  }
  if (options.autonomy === "dangerous")
    process.stderr.write(
      renderNotice(
        "warning",
        "Dangerous autonomy disables approvals and filesystem sandboxing.",
        stderrColor,
      ),
    );
  else if (options.autonomy === "autonomous")
    process.stderr.write(
      renderNotice(
        "notice",
        "--codex-autonomous is now workspace-contained. Use --dangerous-codex-autonomous only for unrestricted behavior.",
        stderrColor,
      ),
    );
  const result =
    command === "install"
      ? await install(options)
      : command === "cleanup"
        ? await cleanup(options)
        : undefined;
  if (result === undefined) {
    process.stderr.write(renderError(`Unknown command: ${command ?? args[0] ?? ""}`, stderrColor));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    options.json ? `${JSON.stringify(result)}\n` : renderRunResult(result, stdoutColor),
  );
}

try {
  await main();
} catch (error) {
  const stderrColor = supportsColor(process.stderr.isTTY, process.env.NO_COLOR);
  process.stderr.write(
    renderError(error instanceof Error ? error.message : String(error), stderrColor),
  );
  process.exitCode = 1;
}
