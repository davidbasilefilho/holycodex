// SPDX-License-Identifier: Apache-2.0

import {
  AssignmentResultInputSchema,
  CreateAssignmentInputSchema,
  CreateIntentInputSchema,
  IntentStateSchema,
  IntentEvidenceInputSchema,
  IntentStore,
  IntentStoreError,
  PlanInputSchema,
} from "@holycodex/core";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { agentHelp, agentHelpRequested } from "./help.ts";

const ResponseVersion = "holycodex-agent-response-1" as const;
const ArgvSchema = Schema.Array(Schema.String);

/** Injectable streams and working directory for deterministic CLI execution. */
export interface AgentIo {
  readonly cwd?: string;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

/** Runs the deterministic model-facing CLI without prompts, TUI, or ANSI. */
export async function runAgentBinary(
  argv: readonly string[] = Bun.argv.slice(2),
  io: AgentIo = {
    cwd: process.cwd(),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  try {
    const validatedArgv = decode(ArgvSchema, argv);
    const path = validatedArgv.filter((value) => !value.startsWith("-")).slice(0, 2);
    if (agentHelpRequested(validatedArgv)) {
      io.writeStdout(agentHelp(path));
      return 0;
    }
    const parsed = parseOptions(validatedArgv);
    const store = new IntentStore(parsed.options["repo"] ?? io.cwd ?? process.cwd());
    const data = await execute(store, parsed.command, parsed.subcommand, parsed.options);
    io.writeStdout(
      `${JSON.stringify({ schema_version: ResponseVersion, ok: true, operation: `${parsed.command}.${parsed.subcommand}`, data })}\n`,
    );
    return 0;
  } catch (error: unknown) {
    const classified = classify(error);
    io.writeStderr(
      `${JSON.stringify({ schema_version: ResponseVersion, ok: false, error: classified })}\n`,
    );
    return classified.code === "invalid_usage" || classified.code === "invalid_input"
      ? 2
      : classified.code === "completion_refused"
        ? 3
        : 1;
  }
}

async function execute(
  store: IntentStore,
  command: string,
  subcommand: string,
  options: Readonly<Record<string, string>>,
): Promise<unknown> {
  const intent = options["intent"];
  if (command === "intent") {
    if (subcommand === "create")
      return await store.createIntent(
        decodeJson(CreateIntentInputSchema, required(options, "input")),
      );
    if (subcommand === "list") return await store.listIntents();
    if (subcommand === "current") return await store.currentIntent();
    if (subcommand === "read") return await store.readIntent(requiredValue(intent, "intent"));
    if (subcommand === "select") return await store.selectCurrent(requiredValue(intent, "intent"));
    if (subcommand === "transition")
      return await store.transitionIntent(
        requiredValue(intent, "intent"),
        decode(IntentStateSchema, required(options, "state")),
        revision(options),
        options["blocker"],
      );
    if (subcommand === "evidence")
      return await store.recordIntentEvidence(
        requiredValue(intent, "intent"),
        revision(options),
        decodeJson(IntentEvidenceInputSchema, required(options, "input")),
      );
    if (subcommand === "abandon")
      return await store.abandonIntent(requiredValue(intent, "intent"), revision(options));
    if (subcommand === "complete") {
      const result = await store.completeIntent(requiredValue(intent, "intent"), revision(options));
      if ("completed" in result && !result.completed)
        throw new AgentCliError("completion_refused", "Intent completion predicates failed.", {
          reasons: result.reasons,
        });
      return result;
    }
  }
  if (command === "plan") {
    if (subcommand === "read")
      return (await store.readPlan(requiredValue(intent, "intent"))) ?? null;
    if (subcommand === "revise")
      return await store.revisePlan(
        requiredValue(intent, "intent"),
        decodeJson(PlanInputSchema, required(options, "input")),
        revision(options),
        optionalInteger(options["plan-revision"]),
      );
  }
  if (command === "assignment") {
    if (subcommand === "create")
      return await store.createAssignment(
        requiredValue(intent, "intent"),
        decodeJson(CreateAssignmentInputSchema, required(options, "input")),
        revision(options),
      );
    if (subcommand === "list") return await store.listAssignments(requiredValue(intent, "intent"));
    if (subcommand === "read")
      return await store.readAssignment(
        requiredValue(intent, "intent"),
        required(options, "assignment"),
      );
    if (subcommand === "start")
      return await store.startAssignment(
        requiredValue(intent, "intent"),
        required(options, "assignment"),
        revision(options),
      );
    if (subcommand === "result")
      return await store.recordAssignmentResult(
        requiredValue(intent, "intent"),
        required(options, "assignment"),
        revision(options),
        decodeJson(AssignmentResultInputSchema, required(options, "input")),
      );
  }
  throw new AgentCliError("invalid_usage", "Unknown command. Use --help.");
}

function parseOptions(argv: readonly string[]): {
  readonly command: string;
  readonly subcommand: string;
  readonly options: Readonly<Record<string, string>>;
} {
  const command = argv[0];
  const subcommand = argv[1];
  if (!command || !subcommand || command.startsWith("-") || subcommand.startsWith("-"))
    throw new AgentCliError("invalid_usage", "A command and subcommand are required. Use --help.");
  const options: Record<string, string> = {};
  const allowed = allowedOptions(command, subcommand);
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new AgentCliError("invalid_usage", "Options require --name value pairs.");
    const key = name.slice(2);
    if (options[key] !== undefined)
      throw new AgentCliError("invalid_usage", `Duplicate option --${key}.`);
    if (!allowed.has(key)) throw new AgentCliError("invalid_usage", `Unknown option --${key}.`);
    options[key] = value;
  }
  return { command, subcommand, options };
}

function allowedOptions(command: string, subcommand: string): ReadonlySet<string> {
  const common = ["repo"];
  const options: Record<string, readonly string[]> = {
    "intent create": ["input"],
    "intent list": [],
    "intent current": [],
    "intent read": ["intent"],
    "intent select": ["intent"],
    "intent transition": ["intent", "revision", "state", "blocker"],
    "intent evidence": ["intent", "revision", "input"],
    "intent complete": ["intent", "revision"],
    "intent abandon": ["intent", "revision"],
    "plan read": ["intent"],
    "plan revise": ["intent", "revision", "plan-revision", "input"],
    "assignment create": ["intent", "revision", "input"],
    "assignment list": ["intent"],
    "assignment read": ["intent", "assignment"],
    "assignment start": ["intent", "assignment", "revision"],
    "assignment result": ["intent", "assignment", "revision", "input"],
  };
  return new Set([...common, ...(options[`${command} ${subcommand}`] ?? [])]);
}

class AgentCliError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function decodeJson<A, I>(schema: Schema.Schema<A, I>, text: string): A {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AgentCliError("invalid_input", "--input must be valid JSON.");
  }
  return decode(schema, value);
}
function decode<A, I>(schema: Schema.Schema<A, I>, value: unknown): A {
  const result = Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(value);
  if (Either.isLeft(result))
    throw new AgentCliError("invalid_input", "Input failed Effect Schema validation.", {
      issue: String(result.left),
    });
  return result.right;
}
function required(options: Readonly<Record<string, string>>, name: string): string {
  return requiredValue(options[name], name);
}
function requiredValue(value: string | undefined, name: string): string {
  if (!value) throw new AgentCliError("invalid_usage", `Missing --${name}.`);
  return value;
}
function revision(options: Readonly<Record<string, string>>): number {
  return requiredInteger(options["revision"], "revision");
}
function requiredInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new AgentCliError("invalid_input", `--${name} must be a positive integer.`);
  return parsed;
}
function optionalInteger(value: string | undefined): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, "plan-revision");
}
function classify(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  if (error instanceof IntentStoreError || error instanceof AgentCliError)
    return { code: error.code, message: error.message, details: error.details };
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : "Agent CLI failed.",
    details: {},
  };
}

export { agentHelp, agentHelpRequested } from "./help.ts";

if (import.meta.main) process.exitCode = await runAgentBinary();
