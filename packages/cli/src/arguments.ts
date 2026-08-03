import {
  DEFAULT_PLAN,
  FastModeSchema,
  PLAN_NAMES,
  PlanNameSchema,
  type FastMode,
  type PlanName,
} from "./catalog.ts";
import type { RequestedAutonomy } from "./config.ts";

export type CliCommand = "install" | "doctor" | "cleanup";
export type CliArguments = {
  readonly action: "help" | "version" | "run";
  readonly command?: CliCommand;
  readonly json: boolean;
  readonly plan: PlanName;
  readonly maxSubagents?: number;
  readonly autonomy: RequestedAutonomy;
  readonly fast: FastMode;
};

const INSTALL_FLAGS = new Set([
  "--plan",
  "--max-subagents",
  "--codex-autonomous",
  "--no-codex-autonomous",
  "--dangerous-codex-autonomous",
  "--fast",
  "--fast-all",
  "--no-fast",
  "--json",
]);
const SHARED_FLAGS = new Set(["--json"]);

/** Strictly parses command-specific HolyCodex CLI arguments. */
export function parseCliArguments(args: readonly string[]): CliArguments {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return base("help");
  if (args[0] === "--version" || args[0] === "-v") {
    if (args.length !== 1) throw new Error("--version does not accept other arguments.");
    return base("version");
  }
  const command = args[0];
  if (command !== "install" && command !== "doctor" && command !== "cleanup")
    throw new Error(`Unknown command: ${command ?? ""}`);
  if (args[1] === "--help" || args[1] === "-h") {
    if (args.length !== 2) throw new Error("--help does not accept other arguments.");
    return { ...base("help"), command };
  }
  const allowed = command === "install" ? INSTALL_FLAGS : SHARED_FLAGS;
  const values = new Map<string, string | true>();
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--"))
      throw new Error(`Unexpected positional argument: ${token ?? ""}`);
    const separator = token.indexOf("=");
    const name = separator < 0 ? token : token.slice(0, separator);
    if (!allowed.has(name)) throw new Error(`Option ${name} is not valid for ${command}.`);
    if (values.has(name)) throw new Error(`Repeated option: ${name}`);
    if (name !== "--plan" && name !== "--max-subagents") {
      if (separator >= 0) throw new Error(`${name} does not accept a value.`);
      values.set(name, true);
      continue;
    }
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--")))
      throw new Error(`Missing value for ${name}.`);
    values.set(name, value);
  }
  const autonomyFlags = [
    "--codex-autonomous",
    "--no-codex-autonomous",
    "--dangerous-codex-autonomous",
  ].filter((flag) => values.has(flag));
  if (autonomyFlags.length > 1)
    throw new Error(`Conflicting autonomy flags: ${autonomyFlags.join(", ")}`);
  const fastFlags = ["--fast", "--fast-all", "--no-fast"].filter((flag) => values.has(flag));
  if (fastFlags.length > 1) throw new Error(`Conflicting Fast flags: ${fastFlags.join(", ")}`);
  const planValue = values.get("--plan") ?? DEFAULT_PLAN;
  const plan = PlanNameSchema.safeParse(planValue);
  if (!plan.success)
    throw new Error(`Unknown plan: ${String(planValue)}. Valid plans: ${PLAN_NAMES.join(", ")}.`);
  const maxValue = values.get("--max-subagents");
  if (
    maxValue !== undefined &&
    (typeof maxValue !== "string" || !/^\d+$/.test(maxValue) || Number(maxValue) > 3)
  )
    throw new Error(
      `Invalid --max-subagents value: ${String(maxValue)}. Expected an integer from 0 through 3.`,
    );
  const autonomy: RequestedAutonomy = values.has("--dangerous-codex-autonomous")
    ? { requested: true, mode: "dangerous" }
    : values.has("--codex-autonomous")
      ? { requested: true, mode: "autonomous" }
      : values.has("--no-codex-autonomous")
        ? { requested: true, mode: "default" }
        : { requested: false };
  const fast = FastModeSchema.parse(
    values.has("--fast-all") ? "fast-all" : values.has("--fast") ? "fast" : "standard",
  );
  return {
    action: "run",
    command,
    json: values.has("--json"),
    plan: plan.data,
    ...(maxValue === undefined ? {} : { maxSubagents: Number(maxValue) }),
    autonomy,
    fast,
  };
}

function base(action: "help" | "version"): CliArguments {
  return {
    action,
    json: false,
    plan: DEFAULT_PLAN,
    autonomy: { requested: false },
    fast: "standard",
  };
}
