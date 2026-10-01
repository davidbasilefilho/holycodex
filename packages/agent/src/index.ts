// SPDX-License-Identifier: Apache-2.0

import {
  AssignmentInvocationCapabilitySchema,
  AssignmentResultInputSchema,
  AssignmentStartInputSchema,
  CreateAssignmentInputSchema,
  CreateIntentInputSchema,
  IntentStateSchema,
  IntentEvidenceInputSchema,
  IntentStore,
  IntentStoreError,
  ReviseAssignmentScopeInputSchema,
  SupersedeAssignmentInputSchema,
  VcsIntegrationInputSchema,
} from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { agentHelp, agentHelpRequested } from "./help.ts";

const ResponseVersion = "holycodex-agent-response-1" as const;
const ArgvSchema = Schema.Array(Schema.String);
const RequiredOptionSchema = Schema.String.check(Schema.isMinLength(1));
const RevisionSchema = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const AssignmentInterruptionRecoveryInputSchema = Schema.Struct({
  invocationId: Schema.String,
  startedAt: Schema.String,
  capability: AssignmentInvocationCapabilitySchema,
  interruptionReason: Schema.String,
});

/** Injectable streams and working directory for deterministic CLI execution. */
export interface AgentIo {
  /** Working directory used as the default repository path. */
  readonly cwd?: string;
  /** Writes one complete response line to standard output. */
  readonly writeStdout: (text: string) => void;
  /** Writes one complete error line to standard error. */
  readonly writeStderr: (text: string) => void;
}

/** Runs the deterministic model-facing CLI without prompts, TUI, or ANSI. */
export function runAgentBinary(
  argv: readonly string[] = Bun.argv.slice(2),
  io: AgentIo = {
    cwd: process.cwd(),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  const run = Effect.gen(function* () {
    const validatedArgv = yield* decode(ArgvSchema, argv);
    if (validatedArgv[0] === "plan")
      return yield* Effect.fail(
        new AgentCliError("invalid_usage", "Planning commands were removed. Use --help."),
      );
    const path = validatedArgv.filter((value) => !value.startsWith("-")).slice(0, 2);
    if (agentHelpRequested(validatedArgv)) {
      yield* Effect.sync(() => io.writeStdout(agentHelp(path)));
      return 0;
    }
    const parsed = yield* parseOptions(validatedArgv);
    const store = new IntentStore(parsed.options["repo"] ?? io.cwd ?? process.cwd());
    const data = yield* execute(store, parsed.command, parsed.subcommand, parsed.options);
    yield* Effect.sync(() =>
      io.writeStdout(
        `${JSON.stringify({ schema_version: ResponseVersion, ok: true, operation: `${parsed.command}.${parsed.subcommand}`, data })}\n`,
      ),
    );
    return 0;
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const classified = classify(error);
        return Effect.sync(() => {
          io.writeStderr(
            `${JSON.stringify({ schema_version: ResponseVersion, ok: false, error: classified })}\n`,
          );
          return classified.code === "invalid_usage" || classified.code === "invalid_input"
            ? 2
            : classified.code === "completion_refused"
              ? 3
              : 1;
        });
      },
      onSuccess: Effect.succeed,
    }),
  );
  return Effect.runPromise(run);
}

function execute(
  store: IntentStore,
  command: string,
  subcommand: string,
  options: Readonly<Record<string, string>>,
) {
  return Effect.gen(function* () {
    const intent = options["intent"];
    if (command === "intent") {
      if (subcommand === "create") {
        const input = yield* decodeJson(CreateIntentInputSchema, yield* required(options, "input"));
        if (input.planRequired)
          return yield* Effect.fail(
            new AgentCliError("invalid_input", "New Intents cannot require a Plan."),
          );
        return yield* store.createIntent(input);
      }
      if (subcommand === "list") return yield* store.listIntents();
      if (subcommand === "current") return yield* store.currentIntent();
      if (subcommand === "read")
        return yield* store.readIntent(yield* requiredValue(intent, "intent"));
      if (subcommand === "select")
        return yield* store.selectCurrent(yield* requiredValue(intent, "intent"));
      if (subcommand === "transition")
        return yield* store.transitionIntent(
          yield* requiredValue(intent, "intent"),
          yield* decode(IntentStateSchema, yield* required(options, "state")),
          yield* revision(options),
          options["blocker"],
        );
      if (subcommand === "evidence")
        return yield* store.recordIntentEvidence(
          yield* requiredValue(intent, "intent"),
          yield* revision(options),
          yield* decodeJson(IntentEvidenceInputSchema, yield* required(options, "input")),
        );
      if (subcommand === "integrate")
        return yield* store.recordVcsIntegration(
          yield* requiredValue(intent, "intent"),
          yield* revision(options),
          yield* decodeJson(VcsIntegrationInputSchema, yield* required(options, "input")),
        );
      if (subcommand === "abandon")
        return yield* store.abandonIntent(
          yield* requiredValue(intent, "intent"),
          yield* revision(options),
        );
      if (subcommand === "complete") {
        const result = yield* store.completeIntent(
          yield* requiredValue(intent, "intent"),
          yield* revision(options),
        );
        if ("completed" in result && !result.completed)
          return yield* Effect.fail(
            new AgentCliError("completion_refused", "Intent completion predicates failed.", {
              reasons: result.reasons,
            }),
          );
        return result;
      }
    }
    if (command === "assignment") {
      if (subcommand === "create")
        return yield* store.createAssignment(
          yield* requiredValue(intent, "intent"),
          yield* decodeJson(CreateAssignmentInputSchema, yield* required(options, "input")),
          yield* revision(options),
        );
      if (subcommand === "revise")
        return yield* store.reviseAssignmentScope(
          yield* requiredValue(intent, "intent"),
          yield* required(options, "assignment"),
          yield* decodeJson(ReviseAssignmentScopeInputSchema, yield* required(options, "input")),
          yield* revision(options),
        );
      if (subcommand === "supersede")
        return yield* store.supersedeAssignment(
          yield* requiredValue(intent, "intent"),
          yield* required(options, "assignment"),
          yield* revision(options),
          yield* decodeJson(SupersedeAssignmentInputSchema, yield* required(options, "input")),
        );
      if (subcommand === "list")
        return yield* store.listAssignments(yield* requiredValue(intent, "intent"));
      if (subcommand === "read")
        return yield* store.readAssignment(
          yield* requiredValue(intent, "intent"),
          yield* required(options, "assignment"),
        );
      if (subcommand === "start") {
        const inputValue = options["input"];
        const input =
          inputValue === undefined ? {} : yield* decodeJson(AssignmentStartInputSchema, inputValue);
        return yield* store.startAssignment(
          yield* requiredValue(intent, "intent"),
          yield* required(options, "assignment"),
          yield* revision(options),
          input,
        );
      }
      if (subcommand === "recover")
        return yield* store.recoverInterruptedAssignment(
          yield* requiredValue(intent, "intent"),
          yield* required(options, "assignment"),
          yield* revision(options),
          yield* decodeJson(
            AssignmentInterruptionRecoveryInputSchema,
            yield* required(options, "input"),
          ),
        );
      if (subcommand === "result") {
        const result = yield* decodeJson(
          AssignmentResultInputSchema,
          yield* required(options, "input"),
        );
        const reference = yield* requiredValue(intent, "intent");
        const assignment = yield* required(options, "assignment");
        const expectedRevision = yield* revision(options);

        if (
          result.capability === undefined &&
          (yield* store.isLegacyExecutingAssignment(reference, assignment))
        )
          return yield* store.recordAssignmentResult(
            reference,
            assignment,
            expectedRevision,
            result,
          );

        return yield* store.recordSpecialistAssignmentResult(
          reference,
          assignment,
          expectedRevision,
          result,
        );
      }
    }
    if (command === "state" && subcommand === "diagnose")
      return yield* store.diagnose(yield* requiredValue(intent, "intent"));
    return yield* Effect.fail(new AgentCliError("invalid_usage", "Unknown command. Use --help."));
  });
}

function parseOptions(argv: readonly string[]) {
  return Effect.gen(function* () {
    const command = argv[0];
    const subcommand = argv[1];
    if (!command || !subcommand || command.startsWith("-") || subcommand.startsWith("-"))
      return yield* Effect.fail(
        new AgentCliError("invalid_usage", "A command and subcommand are required. Use --help."),
      );
    const options: Record<string, string> = {};
    const allowed = allowedOptions(command, subcommand);
    for (let index = 2; index < argv.length; index += 2) {
      const name = argv[index];
      const value = argv[index + 1];
      if (!name?.startsWith("--") || value === undefined || value.startsWith("--"))
        return yield* Effect.fail(
          new AgentCliError("invalid_usage", "Options require --name value pairs."),
        );
      const key = name.slice(2);
      if (options[key] !== undefined)
        return yield* Effect.fail(new AgentCliError("invalid_usage", `Duplicate option --${key}.`));
      if (!allowed.has(key))
        return yield* Effect.fail(new AgentCliError("invalid_usage", `Unknown option --${key}.`));
      options[key] = value;
    }
    return { command, subcommand, options };
  });
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
    "intent integrate": ["intent", "revision", "input"],
    "intent complete": ["intent", "revision"],
    "intent abandon": ["intent", "revision"],
    "assignment create": ["intent", "revision", "input"],
    "assignment revise": ["intent", "assignment", "revision", "input"],
    "assignment supersede": ["intent", "assignment", "revision", "input"],
    "assignment list": ["intent"],
    "assignment read": ["intent", "assignment"],
    "assignment start": ["intent", "assignment", "revision", "input"],
    "assignment recover": ["intent", "assignment", "revision", "input"],
    "assignment result": ["intent", "assignment", "revision", "input"],
    "state diagnose": ["intent"],
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

function decodeJson<A, I>(schema: Schema.ConstraintCodec<A, I>, text: string) {
  return decode(Schema.fromJsonString(schema), text);
}
function decode<A, I>(schema: Schema.ConstraintCodec<A, I>, value: unknown) {
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(
      (issue) =>
        new AgentCliError("invalid_input", "Input failed Effect Schema validation.", {
          issue: String(issue),
        }),
    ),
  );
}
function required(options: Readonly<Record<string, string>>, name: string) {
  return requiredValue(options[name], name);
}
function requiredValue(value: string | undefined, name: string) {
  if (value === undefined)
    return Effect.fail(new AgentCliError("invalid_usage", `Missing --${name}.`));
  return Schema.decodeUnknownEffect(RequiredOptionSchema)(value).pipe(
    Effect.mapError(() => new AgentCliError("invalid_input", `--${name} must not be empty.`)),
  );
}
function revision(options: Readonly<Record<string, string>>) {
  return requiredInteger(options["revision"], "revision");
}
function requiredInteger(value: string | undefined, name: string) {
  return Schema.decodeUnknownEffect(RevisionSchema)(value).pipe(
    Effect.mapError(
      () => new AgentCliError("invalid_input", `--${name} must be a positive integer.`),
    ),
  );
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
