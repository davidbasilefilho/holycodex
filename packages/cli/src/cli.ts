import process from "node:process";

import { DEFAULT_PLAN, PLAN_NAMES, PlanNameSchema, VERSION } from "./catalog.ts";
import { doctor } from "./doctor.ts";
import { cleanup, install, type RunOptions } from "./install.ts";
import {
  renderDoctor,
  renderError,
  formatCliError,
  renderHelp,
  renderInstallHelp,
  renderNotice,
  renderRunResult,
  supportsColor,
} from "./presentation.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stdoutColor = supportsColor(process.stdout.isTTY, process.env.NO_COLOR);
  const stderrColor = supportsColor(process.stderr.isTTY, process.env.NO_COLOR);
  const command = args.find(
    (arg, index) =>
      !arg.startsWith("-") && args[index - 1] !== "--plan" && args[index - 1] !== "--max-subagents",
  );
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(
      command === "install"
        ? renderInstallHelp(VERSION, stdoutColor)
        : renderHelp(VERSION, stdoutColor),
    );
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const planFlags = args.flatMap((arg, index) => (arg === "--plan" ? [index] : []));
  if (planFlags.length > 1) throw new Error("--plan may be specified only once.");
  const planFlagIndex = args.indexOf("--plan");
  const planValue = planFlagIndex < 0 ? DEFAULT_PLAN : args[planFlagIndex + 1];
  if (planValue === undefined || planValue.startsWith("-") || planValue === command)
    throw new Error(`Missing --plan value. Valid plans: ${PLAN_NAMES.join(", ")}.`);
  const parsedPlan = PlanNameSchema.safeParse(planValue);
  if (!parsedPlan.success)
    throw new Error(`Unknown plan: ${planValue}. Valid plans: ${PLAN_NAMES.join(", ")}.`);
  const plan = parsedPlan.data;
  const maxSubagentFlags = args.flatMap((arg, index) => (arg === "--max-subagents" ? [index] : []));
  if (maxSubagentFlags.length > 1) throw new Error("--max-subagents may be specified only once.");
  const maxSubagentsIndex = args.indexOf("--max-subagents");
  const maxSubagentsValue = maxSubagentsIndex < 0 ? undefined : args[maxSubagentsIndex + 1];
  if (
    maxSubagentsIndex >= 0 &&
    (maxSubagentsValue === undefined ||
      maxSubagentsValue.startsWith("--") ||
      maxSubagentsValue === command)
  )
    throw new Error("Missing --max-subagents value. Expected a nonnegative integer.");
  if (maxSubagentsValue !== undefined && !/^\d+$/.test(maxSubagentsValue))
    throw new Error(
      `Invalid --max-subagents value: ${maxSubagentsValue}. Expected a nonnegative integer.`,
    );
  const maxSubagents = maxSubagentsValue === undefined ? undefined : Number(maxSubagentsValue);
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
    plan,
    ...(maxSubagents === undefined ? {} : { maxSubagents }),
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
  process.stderr.write(renderError(formatCliError(error), stderrColor));
  process.exitCode = 1;
}
