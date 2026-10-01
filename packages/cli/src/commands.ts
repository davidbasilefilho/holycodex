// SPDX-License-Identifier: Apache-2.0

import { sanitizeDiagnostics } from "@holycodex/codex";
import {
  CLI_SCHEMA_VERSION,
  parseCliEnvelope,
  type CliEnvelope,
  type JsonObject,
  type JsonValue,
  type ProfileName,
  ProfileNameSchema,
  type ServiceTier,
  ServiceTierSchema,
} from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ArgumentError, parseArgv } from "./args.ts";
import {
  colorEnabled,
  helpRequested,
  helpText,
  helpTopic,
  paintTerminal,
  type TerminalSemanticTone,
} from "./help.ts";
import {
  runOpenTuiConflictResolver,
  runOpenTuiInstallReview,
  runOpenTuiInstallWizard,
} from "./installer-wizard.ts";
import {
  installHolyCodexEffect,
  InstallerError,
  readEffectiveInstallRequestEffect,
  validateInstallOptions,
  type InstallRequest,
} from "./installer.ts";
import { asJsonValue } from "./json.ts";
import {
  doctorHolyCodexEffect,
  inspectRemovalConflictsEffect,
  removeHolyCodexEffect,
} from "./maintenance.ts";
import { readPublicVersion, updateCanonicalVersion, ManifestError } from "./manifest.ts";
import {
  CodexOfficialPluginManager,
  OfficialPluginManagerError,
  ReadOnlyCodexPluginStatus,
} from "./official-manager.ts";
import { PathBoundaryError, resolveInstallerPaths } from "./paths.ts";
import { StorageError } from "./storage.ts";
import type {
  CliContext,
  CommandResult,
  ConflictDecision,
  HumanRenderOptions,
  InstallProgressEvent,
  InstallReview,
  InstallReviewResolver,
  InstallReviewResult,
  InstallResult,
  InstallerOptions,
  ManagedConflict,
  OfficialPluginManager,
  ParsedCommand,
} from "./types.ts";

/** Parse and execute CLI arguments, returning a validated envelope and exit code. */
export function runCli(argv: readonly string[], context: CliContext = {}): Promise<CommandResult> {
  if (argv.length === 0 || helpRequested(argv) || argv[0] === "help") {
    const topic =
      argv[0] === "help"
        ? argv.slice(1).filter((value) => !value.startsWith("-"))[0]
        : helpTopic(argv);
    return Effect.runPromise(
      successEnvelopeEffect(topic === undefined ? "help" : `${topic} help`, {
        help: helpText(topic),
      }).pipe(Effect.map((envelope) => ({ envelope, exitCode: 0 }))),
    );
  }
  const command = Effect.try({ try: () => parseArgv(argv), catch: (error) => error }).pipe(
    Effect.flatMap((parsed) =>
      executeCommandEffect(parsed, context).pipe(
        Effect.flatMap((data) =>
          successEnvelopeEffect(parsed.command, data).pipe(
            Effect.map((envelope) => ({
              envelope,
              exitCode: successExitCode(parsed.command, data),
            })),
          ),
        ),
        Effect.catch((error) => Effect.succeed(failureEnvelope(parsed.command, error))),
      ),
    ),
    Effect.catch((error) => Effect.succeed(failureEnvelope(inferCommand(argv), error))),
  );
  return Effect.runPromise(command);
}

/** Dispatch a parsed command to its installer, maintenance, or version operation. */
export function executeCommand(parsed: ParsedCommand, context: CliContext): Promise<JsonValue> {
  return Effect.runPromise(executeCommandEffect(parsed, context));
}

function executeCommandEffect(
  parsed: ParsedCommand,
  context: CliContext,
): Effect.Effect<JsonValue, unknown> {
  return Effect.gen(function* () {
    switch (parsed.command) {
      case "install":
        return asJsonValue(yield* executeInstallEffect(parsed, context));
      case "doctor": {
        const options = installerOptions(parsed, context);
        const paths = resolveInstallerPaths(options, context.env);
        const officialPluginManager =
          options.officialPluginManager ??
          (yield* createDoctorPluginStatusManagerEffect(paths.codexHome, context.env));
        return asJsonValue(
          yield* doctorHolyCodexEffect(
            { ...options, officialPluginManager },
            context.env ?? process.env,
          ),
        );
      }
      case "remove":
        return asJsonValue(yield* executeRemoveEffect(parsed, context));
      case "version":
        return asJsonValue(yield* executeVersionEffect(parsed));
      case "help":
        return { help: helpText(parsed.positionals[0]) };
      default:
        return yield* Effect.fail(new CliCommandError("invalid_argument", "Unknown command."));
    }
  });
}

function createDoctorPluginStatusManagerEffect(
  codexHome: string,
  environment: Readonly<Record<string, string | undefined>> | undefined,
): Effect.Effect<Pick<OfficialPluginManager, "status" | "getObservedIdentities">, unknown> {
  return Effect.tryPromise({
    try: () => CodexOfficialPluginManager.discover(environment),
    catch: (error) => error,
  }).pipe(
    Effect.catchIf(isCodexExecutableUnavailable, () =>
      Effect.succeed(new ReadOnlyCodexPluginStatus(codexHome)),
    ),
  );
}

function isCodexExecutableUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "discovery_failed" &&
    error.message.startsWith("No Codex executable was found")
  );
}

function executeInstallEffect(
  parsed: ParsedCommand,
  context: CliContext,
): Effect.Effect<InstallResult | { readonly cancelled: true }, unknown> {
  return Effect.gen(function* () {
    const initialRequest = yield* Effect.try({
      try: () => installRequestFromParsed(parsed),
      catch: (error) => error,
    });
    const request = yield* resolveInstallRequestEffect(parsed, context, initialRequest);
    if ("cancelled" in request) return request;
    return yield* installHolyCodexEffect(request, installerOptions(parsed, context), context.env);
  });
}

/** Resolve one validated install request from flags or the interactive wizard. */
function resolveInstallRequestEffect(
  parsed: ParsedCommand,
  context: CliContext,
  initial: InstallRequest,
): Effect.Effect<InstallRequest | { readonly cancelled: true }, unknown> {
  const interactive =
    parsed.options["json"] !== true &&
    parsed.options["yes"] !== true &&
    context.io?.stdoutIsTTY === true &&
    context.io?.stderrIsTTY === true;
  if (interactive) {
    return Effect.gen(function* () {
      const previous = yield* readEffectiveInstallRequestEffect(
        installerOptions(parsed, context),
        context.env ?? process.env,
      );
      const result = yield* Effect.tryPromise({
        try: () =>
          (context.io?.installWizard ?? runOpenTuiInstallWizard)({
            ...previous,
            ...initial,
            ...(previous.optional === undefined && initial.optional === undefined
              ? {}
              : { optional: { ...previous.optional, ...initial.optional } }),
          }),
        catch: (error) => error,
      });
      if (result.action === "cancel") return { cancelled: true };
      return yield* Effect.try({
        try: () => validateInstallOptions(result.request),
        catch: (error) => error,
      });
    });
  }
  return Effect.gen(function* () {
    const confirmationResult = yield* confirmationEffect(
      parsed,
      context,
      "Install HolyCodex into the selected Codex home?",
    );
    if (confirmationResult === "cancelled") return { cancelled: true };
    if (confirmationResult === "unavailable") {
      return yield* Effect.fail(
        new CliCommandError(
          "non_tty_confirmation_required",
          "Install requires --yes in non-interactive mode.",
        ),
      );
    }
    return yield* Effect.try({
      try: () => validateInstallOptions(initial),
      catch: (error) => error,
    });
  });
}

function installRequestFromParsed(parsed: ParsedCommand): InstallRequest {
  const profile = optionProfile(parsed);
  const tier = optionTier(parsed);
  const optional = optionalSelections(parsed);
  const officialPlugins =
    parsed.options["add-plugin"] === undefined ? undefined : optionStrings(parsed, "add-plugin");
  return validateInstallOptions({
    ...(profile === undefined ? {} : { profile }),
    ...(tier === undefined ? {} : { tier }),
    ...(optional === undefined ? {} : { optional }),
    ...(officialPlugins === undefined ? {} : { officialPlugins }),
  });
}

function executeRemoveEffect(
  parsed: ParsedCommand,
  context: CliContext,
): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    const confirmationResult = yield* confirmationEffect(
      parsed,
      context,
      "Remove HolyCodex-owned Codex state?",
    );
    if (confirmationResult === "cancelled") {
      return { cancelled: true, removed: [], preserved: [], reasons: ["cancelled"] };
    }
    if (confirmationResult === "unavailable") {
      const conflicts = yield* inspectRemovalConflictsEffect(
        installerOptions(parsed, context),
        context.env ?? process.env,
      );
      const conflict = conflicts[0];
      if (conflict !== undefined) {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            "Modified HolyCodex-owned state requires confirmation before removal.",
            undefined,
            {
              path: conflict.path,
              ...(conflict.key === undefined ? {} : { key: conflict.key }),
              action: conflict.action,
            },
          ),
        );
      }
      return yield* Effect.fail(
        new CliCommandError(
          "non_tty_confirmation_required",
          "Remove requires --yes in non-interactive mode.",
        ),
      );
    }
    return yield* removeHolyCodexEffect(
      installerOptions(parsed, context),
      context.env ?? process.env,
    );
  });
}

function executeVersionEffect(parsed: ParsedCommand): Effect.Effect<unknown, unknown> {
  const target = parsed.positionals[0];
  if (!target) {
    return Effect.tryPromise({ try: () => readPublicVersion(), catch: (error) => error }).pipe(
      Effect.map((version) => ({ version })),
    );
  }
  return Effect.tryPromise({
    try: () => updateCanonicalVersion(target, parsed.options["dry-run"] === true),
    catch: (error) => error,
  });
}

function confirmationEffect(
  parsed: ParsedCommand,
  context: CliContext,
  message: string,
): Effect.Effect<ConfirmationResult, unknown> {
  if (parsed.options["yes"] === true) return Effect.succeed("confirmed");
  if (
    parsed.options["json"] === true ||
    context.io?.stdoutIsTTY !== true ||
    context.io?.stderrIsTTY !== true
  )
    return Effect.succeed("unavailable");
  return confirmIfAvailableEffect(context, message);
}

function confirmIfAvailableEffect(
  context: CliContext,
  message: string,
): Effect.Effect<ConfirmationResult, unknown> {
  if (context.io?.confirm === undefined) return Effect.succeed("unavailable");
  return Effect.tryPromise({
    try: () => context.io!.confirm!(message),
    catch: (error) => error,
  }).pipe(
    Effect.map((result) =>
      result === "confirmed" || result === "cancelled" || result === "unavailable"
        ? result
        : result
          ? "confirmed"
          : "cancelled",
    ),
  );
}

function optionalSelections(parsed: ParsedCommand) {
  const result: Record<string, boolean> = {};
  for (const key of ["browser_use", "computer_use", "sites"] as const) {
    const positive = key.replaceAll("_", "-");
    if (parsed.options[positive] === true) result[key] = true;
    else if (parsed.options[positive] === false) result[key] = false;
    else if (parsed.options[`no-${positive}`] === true) result[key] = false;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function optionProfile(parsed: ParsedCommand): ProfileName | undefined {
  const result = Schema.decodeUnknownResult(ProfileNameSchema)(parsed.options["profile"]);
  return Result.isSuccess(result) ? result.success : undefined;
}

function optionTier(parsed: ParsedCommand): ServiceTier | undefined {
  const result = Schema.decodeUnknownResult(ServiceTierSchema)(parsed.options["tier"]);
  return Result.isSuccess(result) ? result.success : undefined;
}

function optionStrings(parsed: ParsedCommand, key: string): readonly string[] {
  const result = Schema.decodeUnknownResult(Schema.Array(Schema.String))(parsed.options[key]);
  return Result.isSuccess(result) ? result.success : [];
}

function installerOptions(parsed: ParsedCommand, context: CliContext) {
  const base = context.installer ?? {};
  const json = parsed.options["json"] === true;
  const interactiveReview =
    !json &&
    parsed.options["yes"] !== true &&
    context.io?.stdoutIsTTY === true &&
    context.io?.stderrIsTTY === true;
  const onProgress = (event: InstallProgressEvent): void => {
    base.onProgress?.(event);
    context.onProgress?.(event);
    emitProgress(context, json, event.message);
  };
  const selectedConflictDecisions = new Map<string, ConflictDecision>();
  const recordConflictDecisions = (
    conflicts: readonly ManagedConflict[],
    decisions: Readonly<Record<string, ConflictDecision>>,
  ): Readonly<Record<string, ConflictDecision>> => {
    for (const conflict of conflicts) {
      const identity = conflictIdentity(conflict);
      const decision = decisions[identity];
      if (decision !== undefined) selectedConflictDecisions.set(identity, decision);
    }
    return decisions;
  };
  const resolveConflict: NonNullable<InstallerOptions["resolveConflict"]> =
    base.resolveConflict ??
    ((conflict) =>
      Effect.gen(function* () {
        if (parsed.options["yes"] === true) {
          const decision = yield* yesConflictDecisionEffect(conflict);
          yield* warnAboutYesConflictDecisionsEffect(context, [conflict]);
          return decision === "keep" ? "decline" : decision === "cancel" ? "cancel" : "accept";
        }
        if (
          parsed.options["json"] === true ||
          context.io?.stdoutIsTTY !== true ||
          context.io?.stderrIsTTY !== true
        ) {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              `Review the modified HolyCodex-owned state at ${conflict.key === undefined ? conflict.path : `${conflict.path} (${conflict.key})`} in an interactive terminal; --yes preserves user changes.`,
              undefined,
              {
                path: conflict.path,
                ...(conflict.key === undefined ? {} : { key: conflict.key }),
              },
            ),
          );
        }
        const identity = conflictIdentity(conflict);
        const result = yield* Effect.tryPromise({
          try: () =>
            runOpenTuiConflictResolver(
              [conflict],
              {},
              Object.fromEntries(selectedConflictDecisions),
            ),
          catch: (error) => error,
        });
        if (result.action === "back") return "decline";
        if (result.action !== "continue") return "cancel";
        const decision = result.decisions[identity];
        if (decision !== undefined) selectedConflictDecisions.set(identity, decision);
        if (decision === "replace" || decision === "remove") return "accept";
        if (decision === "keep") return "decline";
        return "cancel";
      }));
  const configuredResolveConflicts: NonNullable<InstallerOptions["resolveConflicts"]> =
    base.resolveConflicts ??
    (parsed.options["yes"] === true
      ? (conflicts) =>
          Effect.gen(function* () {
            const decisions: Record<string, ConflictDecision> = {};
            for (const conflict of conflicts) {
              decisions[conflictIdentity(conflict)] = yield* yesConflictDecisionEffect(conflict);
            }
            yield* warnAboutYesConflictDecisionsEffect(context, conflicts);
            return decisions;
          })
      : (conflicts) =>
          Effect.gen(function* () {
            if (
              parsed.options["json"] === true ||
              context.io?.stdoutIsTTY !== true ||
              context.io?.stderrIsTTY !== true
            ) {
              return yield* Effect.fail(
                new InstallerError(
                  "confirmation_required",
                  "Managed conflicts require an interactive review or --yes.",
                ),
              );
            }
            const result = yield* Effect.tryPromise({
              try: () =>
                runOpenTuiConflictResolver(
                  conflicts,
                  {},
                  Object.fromEntries(selectedConflictDecisions),
                ),
              catch: (error) => error,
            });
            if (result.action === "back") {
              const decisions: Record<string, ConflictDecision> = Object.fromEntries(
                conflicts.map((conflict) => {
                  const valid =
                    conflict.validDecisions ??
                    (conflict.action === "remove"
                      ? ["keep", "remove", "cancel"]
                      : ["keep", "replace", "cancel"]);
                  return [
                    conflictIdentity(conflict),
                    valid.includes("keep") ? ("keep" as const) : ("cancel" as const),
                  ];
                }),
              );
              return recordConflictDecisions(conflicts, decisions);
            }
            if (result.action === "cancel")
              return yield* Effect.fail(
                new InstallerError("confirmation_required", "Conflict review was cancelled."),
              );
            if (result.action === "continue") return result.decisions;
            return yield* Effect.fail(
              new InstallerError("confirmation_required", "Conflict review was reopened."),
            );
          }));
  const resolveConflicts: NonNullable<InstallerOptions["resolveConflicts"]> = (conflicts) =>
    configuredResolveConflicts(conflicts).pipe(
      Effect.map((decisions) => recordConflictDecisions(conflicts, decisions)),
    );
  const configuredReview: InstallReviewResolver | undefined =
    base.reviewInstall ??
    (context.io?.installReview === undefined
      ? undefined
      : (plan: InstallReview) =>
          Effect.tryPromise({
            try: () => context.io!.installReview!(plan),
            catch: (error) => error,
          }));
  const review: InstallReviewResolver | undefined =
    configuredReview ??
    (parsed.options["yes"] === true
      ? (): Effect.Effect<InstallReviewResult> => Effect.succeed({ action: "apply" })
      : interactiveReview
        ? (plan: InstallReview) =>
            Effect.tryPromise({ try: () => runOpenTuiInstallReview(plan), catch: (error) => error })
        : undefined);
  const reviewInstall: InstallReviewResolver | undefined =
    review === undefined
      ? undefined
      : (plan: InstallReview) =>
          Effect.gen(function* () {
            const reviewedPlan = withSelectedConflictDecisions(plan, selectedConflictDecisions);
            const result = yield* review(installReviewForCli(reviewedPlan));
            if (result.action !== "change") return result;
            if (result.request !== undefined) {
              return yield* Effect.try({
                try: () =>
                  ({
                    action: "change",
                    request: validateInstallOptions(result.request),
                  }) as const,
                catch: (error) => error,
              });
            }
            if (!interactiveReview) {
              return yield* Effect.fail(
                new InstallerError(
                  "confirmation_required",
                  "Changing install options requires an interactive review.",
                ),
              );
            }
            const changed = yield* Effect.tryPromise({
              try: () =>
                (context.io?.installWizard ?? runOpenTuiInstallWizard)(
                  installRequestFromReview(reviewedPlan),
                ),
              catch: (error) => error,
            });
            if (changed.action === "cancel") return { action: "cancel" };
            return yield* Effect.try({
              try: () =>
                ({ action: "change", request: validateInstallOptions(changed.request) }) as const,
              catch: (error) => error,
            });
          });
  const codexHome = parsed.options["codex-home"];
  if (typeof codexHome !== "string")
    return {
      ...base,
      onProgress,
      resolveConflict,
      resolveConflicts,
      ...(reviewInstall === undefined ? {} : { reviewInstall }),
      ...(context.now ? { now: context.now } : {}),
    };
  return {
    ...base,
    paths: { ...base.paths, codexHome },
    onProgress,
    resolveConflict,
    resolveConflicts,
    ...(reviewInstall === undefined ? {} : { reviewInstall }),
    ...(context.now ? { now: context.now } : {}),
  };
}

function yesConflictDecisionEffect(
  conflict: ManagedConflict,
): Effect.Effect<ConflictDecision, InstallerError> {
  const valid =
    conflict.validDecisions ??
    (conflict.action === "remove" ? ["keep", "remove", "cancel"] : ["keep", "replace", "cancel"]);
  const action = conflict.action === "remove" ? "remove" : "replace";
  const decision = valid.includes(action) ? action : undefined;
  if (decision === undefined) {
    return Effect.fail(
      new InstallerError(
        "confirmation_required",
        `--yes cannot resolve ${conflict.target ?? conflict.key ?? conflict.path}; choose ${valid.join(", ")}.`,
        undefined,
        {
          path: conflict.path,
          ...(conflict.key === undefined ? {} : { key: conflict.key }),
        },
      ),
    );
  }
  return Effect.succeed(decision);
}

function warnAboutYesConflictDecisionsEffect(
  context: CliContext,
  conflicts: readonly ManagedConflict[],
): Effect.Effect<void, InstallerError> {
  if (conflicts.length === 0) return Effect.void;
  return Effect.gen(function* () {
    const decisions: string[] = [];
    for (const conflict of conflicts) {
      const action = yield* yesConflictDecisionEffect(conflict);
      const target =
        conflict.key === undefined ? conflict.path : `${conflict.path} (${conflict.key})`;
      if (action !== "keep") decisions.push(`${action} ${target}`);
    }
    if (decisions.length === 0) return;
    context.io?.writeStderr?.(
      `Warning: --yes will apply these conflict decisions: ${decisions.join("; ")}. This may overwrite existing Codex configuration.\n`,
    );
  });
}

function installRequestFromReview(plan: InstallReview): InstallRequest {
  return validateInstallOptions({
    profile: plan.profile,
    tier: plan.tier,
    optional: plan.capabilities,
    officialPlugins: plan.additionalPlugins,
  });
}

function conflictIdentity(conflict: ManagedConflict): string {
  return conflict.identity ?? conflict.path;
}

function withSelectedConflictDecisions(
  plan: InstallReview,
  selected: ReadonlyMap<string, ConflictDecision>,
): InstallReview {
  if (selected.size === 0 || plan.conflicts.length === 0) return plan;
  return {
    ...plan,
    conflicts: plan.conflicts.map((conflict) => {
      const decision = selected.get(conflictIdentity(conflict));
      return decision === undefined ? conflict : { ...conflict, decision };
    }),
  };
}

function installReviewForCli(plan: InstallReview): InstallReview {
  const { fromVersion: _fromVersion, ...installPlan } = plan;
  return { ...installPlan, operation: "install" };
}

function successEnvelopeEffect(
  command: string,
  data: JsonValue,
): Effect.Effect<CliEnvelope, CliCommandError> {
  const parsed = parseCliEnvelope({
    schema_version: CLI_SCHEMA_VERSION,
    ok: true,
    command,
    data,
    warnings: [],
  });
  if (!parsed.ok)
    return Effect.fail(
      new CliCommandError("internal_error", "The success envelope failed validation."),
    );
  return Effect.succeed(parsed.value);
}

function failureEnvelope(command: string, error: unknown): CommandResult {
  const mapped = mapError(error, command);
  const parsed = parseCliEnvelope({
    schema_version: CLI_SCHEMA_VERSION,
    ok: false,
    command,
    error: { code: mapped.code, message: mapped.message, details: mapped.details },
    warnings: [],
  });
  if (!parsed.ok) {
    return {
      envelope: {
        schema_version: CLI_SCHEMA_VERSION,
        ok: false,
        command: "internal-error",
        error: {
          code: "internal_error",
          message: "The CLI failure envelope was invalid.",
          details: {},
        },
        warnings: [],
      },
      exitCode: 5,
    };
  }
  return { envelope: parsed.value, exitCode: mapped.exitCode };
}

function successExitCode(command: string, data: JsonValue): number {
  if (command === "doctor" && isJsonObject(data) && data["healthy"] === false) return 4;
  if (command === "remove" && isJsonObject(data)) {
    if (data["cancelled"] === true) return 1;
    if (arrayValue(data, "preserved").length > 0 || arrayValue(data, "reasons").length > 0)
      return 4;
  }
  return 0;
}

function mapError(
  error: unknown,
  operation: string,
): Readonly<{ code: string; message: string; details: JsonObject; exitCode: number }> {
  if (error instanceof ArgumentError)
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: error.details,
      exitCode: 1,
    };
  if (error instanceof CliCommandError)
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: error.code === "internal_error" ? 5 : 1,
    };
  if (error instanceof PathBoundaryError)
    return {
      code: "trust_boundary_failed",
      message: sanitizeMessage(error.message),
      details: {},
      exitCode: 4,
    };
  if (error instanceof InstallerError) {
    const installerError = error;
    const exitCode =
      installerError.code === "confirmation_required"
        ? 1
        : installerError.code === "capability_denied"
          ? 2
          : installerError.code === "state_corrupt"
            ? 4
            : 3;
    return {
      code: installerError.code,
      message: sanitizeDiagnosticMessage(installerError.message),
      details: detailsWithCause(installerError.details, installerError.causeValue, operation),
      exitCode,
    };
  }
  if (error instanceof OfficialPluginManagerError) {
    const uncertain = ["timeout", "output_limit", "cancelled", "readback_mismatch"].includes(
      error.code,
    );
    const denied =
      error.code === "plugin_disabled" ||
      error.code === "plugin_missing" ||
      error.code === "command_failed";
    return {
      code: uncertain ? "effect_uncertain" : denied ? "capability_denied" : "install_failed",
      message: sanitizeDiagnosticMessage(error.message),
      details: detailsWithCause(error.details, error.causeValue, operation),
      exitCode: uncertain ? 4 : denied ? 2 : 3,
    };
  }
  if (error instanceof StorageError)
    return {
      code: error.code,
      message: sanitizeDiagnosticMessage(error.message),
      details: detailsWithCause({}, error.causeValue, operation),
      exitCode: 4,
    };
  if (error instanceof ManifestError)
    return { code: error.code, message: sanitizeMessage(error.message), details: {}, exitCode: 1 };
  if (error instanceof Error)
    return {
      code: "internal_error",
      message: `The ${operation} command failed unexpectedly.`,
      details: {
        operation,
        cause: sanitizeDiagnostics(`${error.name}: ${error.message}`).join(" ").slice(0, 512),
      },
      exitCode: 5,
    };
  return {
    code: "internal_error",
    message: `The ${operation} command failed unexpectedly.`,
    details: { operation, cause: "A non-Error value was thrown." },
    exitCode: 5,
  };
}

function detailsWithCause(
  details: Readonly<Record<string, JsonValue>>,
  cause: unknown,
  operation: string,
): JsonObject {
  const result: Record<string, JsonValue> = { ...details };
  if (cause !== undefined) {
    if (typeof result["operation"] !== "string") result["operation"] = operation;
    result["cause"] = sanitizeDiagnostics(causeSummary(cause)).join(" ").slice(0, 512);
  }
  return result;
}

function causeSummary(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  return "The operation failed with a non-Error cause.";
}

function sanitizeDiagnosticMessage(message: string): string {
  return sanitizeMessage(sanitizeDiagnostics(message).join(" "));
}

function inferCommand(argv: readonly string[]): string {
  return argv.find((item) => !item.startsWith("-")) ?? "unknown";
}

function sanitizeMessage(message: string): string {
  return Array.from(message)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitProgress(context: CliContext, json: boolean, message: string): void {
  if (json || context.io?.stderrIsTTY === false) return;
  context.io?.writeStderr?.(
    `${renderProgress(message, { stderrIsTTY: context.io?.stderrIsTTY, env: context.env })}\n`,
  );
}

type ConfirmationResult = "confirmed" | "cancelled" | "unavailable";

/** Render a command result as human-readable terminal output. */
export function renderHuman(result: CommandResult, options: HumanRenderOptions = {}): string {
  const color = colorEnabled(options);
  if (result.envelope.ok) {
    if (result.envelope.command === "version") return renderVersion(result.envelope.data);
    if (result.envelope.command === "install") return renderInstall(result.envelope.data, color);
    if (result.envelope.command === "remove") return renderRemove(result.envelope.data, color);
    if (result.envelope.command === "doctor") return renderDoctor(result.envelope.data, color);
    return `${paint("✔", "green", color)} ${paint(result.envelope.command, "heading", color)}\n${renderData(result.envelope.data, color)}`;
  }
  const error = result.envelope.error;
  const hint = actionableHint(error.code, result.envelope.command);
  return [
    `${paint("✖", "red", color)} ${paint(result.envelope.command, "heading", color)}`,
    `  ${paint(error.code, "red", color)}: ${error.message}`,
    ...renderDetails(error.details, color),
    ...(hint === undefined ? [] : [`  hint: ${hint}`]),
    "",
  ].join("\n");
}

/** Render a progress message using the terminal's configured semantic color. */
export function renderProgress(
  message: string,
  options: Pick<HumanRenderOptions, "stderrIsTTY" | "env"> = {},
): string {
  return `${paint("•", "cyan", colorEnabled({ ...options, stream: "stderr" }))} ${message}`;
}

function renderVersion(data: JsonValue): string {
  if (isJsonObject(data) && typeof data["version"] === "string") {
    return `holycodex ${data["version"]}\n`;
  }
  if (isJsonObject(data) && typeof data["next"] === "string") {
    const previous = typeof data["previous"] === "string" ? ` (from ${data["previous"]})` : "";
    return `holycodex version updated to ${data["next"]}${previous}\n`;
  }
  return "holycodex version completed\n";
}

function renderInstall(data: JsonValue, color: boolean): string {
  if (dataValue(data, "cancelled") === true) {
    return `${paint("↩", "cyan", color)} ${paint("install", "heading", color)} cancelled\n`;
  }
  const record = objectValue(data, "record");
  const version = stringValue(record, "version") ?? "unknown";
  const profile = stringValue(record, "profile") ?? "unknown";
  const tier = stringValue(record, "tier") ?? "unknown";
  const capabilityState = objectValue(record, "capability_state");
  const capabilities = ["frontend", "security", "sites", "browser_use", "computer_use"]
    .filter((name) => objectValue(capabilityState, name)?.["selected"] === true)
    .map((name) => {
      const status = stringValue(objectValue(capabilityState, name), "status");
      return status === undefined || status === "healthy" ? name : `${name} (${status})`;
    });
  const preserved = arrayValue(data, "preserved");
  const warnings = arrayValue(data, "warnings");
  const capabilitySummary = capabilities.length === 0 ? "none" : capabilities.join(", ");
  const preservedSummary =
    preserved.length === 0
      ? "none"
      : `${preserved.length} managed item${preserved.length === 1 ? "" : "s"} (review before retrying)`;
  const lines = [
    `${paint("✔", "green", color)} ${paint("install", "heading", color)}`,
    `  ${paint("version", "option", color)}: ${version}`,
    `  ${paint("profile", "option", color)}: ${profile}`,
    `  ${paint("tier", "option", color)}: ${tier}`,
    `  ${paint("capabilities", "option", color)}: ${capabilitySummary}`,
    `  ${paint("preserved", "option", color)}: ${preservedSummary}`,
    ...warnings.map(
      (warning) => `  ${paint("warning", "warning", color)}: ${humanizeReason(warning)}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function renderRemove(data: JsonValue, color: boolean): string {
  if (dataValue(data, "cancelled") === true) {
    return `${paint("↩", "cyan", color)} ${paint("remove", "heading", color)} cancelled\n`;
  }
  const removed = arrayValue(data, "removed");
  const preserved = arrayValue(data, "preserved");
  const reasons = arrayValue(data, "reasons");
  const preservedSummary =
    preserved.length === 0
      ? "none"
      : `${preserved.length} item${preserved.length === 1 ? "" : "s"} (review before retrying)`;
  const incomplete = preserved.length > 0 || reasons.length > 0;
  const heading = incomplete ? "remove incomplete" : "remove";
  const lines = [
    `${paint(incomplete ? "!" : "✔", incomplete ? "warning" : "green", color)} ${paint(heading, incomplete ? "warning" : "heading", color)}`,
    `  ${paint("removed", "option", color)}: ${removed.length} owned item${removed.length === 1 ? "" : "s"}`,
    `  ${paint("preserved", "option", color)}: ${preservedSummary}`,
    ...reasons.map((reason) => `  ${paint("reason", "option", color)}: ${humanizeReason(reason)}`),
  ];
  return `${lines.join("\n")}\n`;
}

function renderDoctor(data: JsonValue, color: boolean): string {
  const healthy = dataValue(data, "healthy") === true;
  const checks = objectValue(data, "checks");
  const entries = checks === undefined ? [] : Object.entries(checks);
  const issues = entries.flatMap(([name, value]) => {
    const check = isJsonObject(value) ? value : undefined;
    const status = stringValue(check, "status");
    if (status === undefined || status === "healthy") return [];
    const reasons = arrayValue(check, "reasons");
    return [
      `  ${paint(name, "option", color)}: ${reasons.length === 0 ? status : reasons.map(humanizeReason).join(", ")}`,
    ];
  });
  const symbol = healthy ? paint("✔", "green", color) : paint("✖", "red", color);
  const lines = [
    `${symbol} ${paint("doctor", "heading", color)}`,
    `  ${paint("status", "option", color)}: ${healthy ? "healthy" : "needs attention"}`,
    `  ${paint("checks", "option", color)}: ${entries.length}`,
    ...(issues.length === 0 ? [] : [`  ${paint("issues", "option", color)}:`, ...issues]),
  ];
  return `${lines.join("\n")}\n`;
}

function objectValue(value: unknown, key: string): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined;
  return isJsonObject(value[key]) ? value[key] : undefined;
}

function dataValue(value: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

function stringValue(value: JsonObject | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" ? item : undefined;
}

function arrayValue(value: unknown, key: string): readonly JsonValue[] {
  if (!isJsonObject(value) || !Array.isArray(value[key])) return [];
  return value[key];
}

function humanizeReason(reason: JsonValue): string {
  if (typeof reason !== "string") return "operation requires review";
  return reason.replaceAll("_", " ");
}

function renderData(data: JsonValue, color: boolean): string {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return `  ${paint(formatValue(data), "dim", color)}\n`;
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  const width = Math.max(...entries.map(([key]) => key.length));
  return `${entries.map(([key, value]) => `  ${paint(key.padEnd(width), "option", color)}: ${formatValue(value)}`).join("\n")}\n`;
}

function renderDetails(details: JsonObject, color: boolean): readonly string[] {
  return Object.entries(details).map(
    ([key, value]) =>
      `  ${paint(key, "option", color)}: ${paint(formatValue(value), "dim", color)}`,
  );
}

function formatValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function actionableHint(code: string, command: string): string | undefined {
  if (code === "unknown_command") return "run `holycodex --help` to list supported commands";
  if (code === "invalid_argument") return `holycodex ${command} --help`;
  if (code === "non_tty_confirmation_required")
    return "rerun with --yes or use an interactive terminal";
  if (code === "capability_denied")
    return "run `holycodex doctor` to inspect capability availability";
  return undefined;
}

type Color = "red" | "green" | "cyan" | "dim" | "warning" | "heading" | "option";

function paint(value: string, color: Color, enabled: boolean): string {
  const tones: Record<Color, TerminalSemanticTone> = {
    red: "error",
    green: "success",
    cyan: "focus",
    dim: "hint",
    warning: "warning",
    heading: "heading",
    option: "option",
  };
  return paintTerminal(value, tones[color], enabled);
}

/** Structured failure returned by a CLI command boundary. */
export class CliCommandError extends Error {
  /** The code in color. */
  readonly code:
    | "invalid_argument"
    | "non_tty_confirmation_required"
    | "install_cancelled"
    | "internal_error";

  constructor(code: CliCommandError["code"], message: string) {
    super(message);
    this.name = "CliCommandError";
    this.code = code;
  }
}
