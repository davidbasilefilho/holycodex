import process from "node:process";

import { parseCliArguments } from "./arguments.ts";
import { VERSION } from "./catalog.ts";
import { doctor } from "./doctor.ts";
import { cleanup, install, type RunOptions } from "./install.ts";
import {
  formatCliError,
  renderDoctor,
  renderError,
  renderHelp,
  renderInstallHelp,
  renderNotice,
  renderRunResult,
  supportsColor,
} from "./presentation.ts";

async function main(): Promise<void> {
  const parsed = parseCliArguments(process.argv.slice(2));
  const stdoutColor = supportsColor(process.stdout.isTTY, process.env.NO_COLOR);
  const stderrColor = supportsColor(process.stderr.isTTY, process.env.NO_COLOR);
  if (parsed.action === "help") {
    process.stdout.write(
      parsed.command === "install"
        ? renderInstallHelp(VERSION, stdoutColor)
        : renderHelp(VERSION, stdoutColor),
    );
    return;
  }
  if (parsed.action === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const options: RunOptions = {
    autonomy: parsed.autonomy,
    fast: parsed.fast,
    json: parsed.json,
    plan: parsed.plan,
    ...(parsed.maxSubagents === undefined ? {} : { maxSubagents: parsed.maxSubagents }),
  };
  if (parsed.command === "doctor") {
    const result = await doctor();
    process.stdout.write(
      parsed.json ? `${JSON.stringify(result)}\n` : renderDoctor(result, stdoutColor),
    );
    if (!result.healthy) process.exitCode = 1;
    return;
  }
  if (parsed.autonomy.requested && parsed.autonomy.mode === "dangerous")
    process.stderr.write(
      renderNotice(
        "warning",
        "Dangerous autonomy disables approvals and filesystem sandboxing.",
        stderrColor,
      ),
    );
  const result = parsed.command === "install" ? await install(options) : await cleanup(options);
  process.stdout.write(
    parsed.json ? `${JSON.stringify(result)}\n` : renderRunResult(result, stdoutColor),
  );
}

try {
  await main();
} catch (error) {
  const color = supportsColor(process.stderr.isTTY, process.env.NO_COLOR);
  process.stderr.write(renderError(formatCliError(error), color));
  process.exitCode = 1;
}
