// SPDX-License-Identifier: Apache-2.0

import { type JsonValue } from "@holycodex/core";
import { fileURLToPath } from "node:url";
import {
  mergeWorkflowLimits,
  parseProtocolLine,
  serializeProtocolMessage,
  toWireLimits,
  validateJsonValue,
  WorkflowRuntimeError,
  type OperationRequestMessage,
  type OperationResultMessage,
  type TerminalFailureMessage,
  type WorkflowLimits,
  type WorkflowLimitsInput,
  type WorkflowOperation,
  type WorkflowOperationHandler,
  type WorkflowProtocolMessage,
  type WorkflowResult,
} from "./protocol.ts";

export const packageName = "@holycodex/workflow-runtime" as const;

export { workflow, Workflow, Step, Queue, Run, Wait } from "./dsl.ts";
export type {
  Assignment,
  AssignmentMetadata,
  NamedWaitResult,
  StepDefinition,
  WorkflowDsl,
  WorkflowCondition,
  WorkflowPredicate,
  WorkflowRepeatUntil,
  WorkflowStage,
} from "./dsl.ts";
export { createCodec, decodePortableSchema } from "./schema.ts";
export type { PortableSchema, PortableSchemaIR, ValueCodec } from "./schema.ts";
export {
  CompileOptionsSchema,
  ExecutionPlan,
  compileWorkflow,
  compileWorkflowUnsafe,
  hydrateWorkflowPlanIR,
  compileWorkflowPlanIR,
} from "./compiler.ts";
export type {
  CompileOptions,
  CompiledNode,
  CompiledNodeMetadata,
  PlanCapacity,
  PlanTerminal,
} from "./compiler.ts";
export {
  NATIVE_OUTPUT_REFERENCE_KEY,
  NATIVE_WORKFLOW_ABI_VERSION,
  freezeWorkflowPlanIR,
  nativeWorkflowIdentityDigest,
  validateWorkflowPlanIR,
  nativePlanJson,
} from "./native-ir.ts";
export type {
  NativeWorkflow,
  NativeWorkflowAssignmentIR,
  NativeWorkflowCapacityInputsIR,
  NativeWorkflowCodecIR,
  NativeWorkflowInputIR,
  NativeWorkflowNodeIR,
  NativeWorkflowOutputIR,
  NativeWorkflowOutputTargetIR,
  NativeWorkflowTerminalIR,
  NativeWorkflowIdentityInput,
  WorkflowPlanIR,
} from "./native-ir.ts";
export type { NativeWorkflowLimits, NativeWorkflowLimitsInput } from "./native-source.ts";
export {
  DEFAULT_NATIVE_WORKFLOW_LIMITS,
  evaluateNativeWorkflowSource,
  loadNativeWorkflowSource,
  mergeNativeWorkflowLimits,
} from "./native-source.ts";
export { transformNativeWorkflowSource } from "./transform.ts";
export { makeCapacityService, runExecutionPlan, runExecutionPlanPromise } from "./runtime.ts";
export type {
  CapacityDispatchRequest,
  CapacityLease,
  CapacityLedgerSnapshot,
  CapacityRunReservation,
  CapacityRunRestoreRequest,
  CapacityRunReservationRequest,
  CapacitySettlement,
  CapacityService,
  WorkflowApprovalRequest,
  WorkflowCheckpoint,
  WorkflowHostServices,
  WorkflowJournalEvent,
  WorkflowRuntimeOptions,
  WorkflowVerificationRequest,
} from "./runtime.ts";
export { workflowFailure, isWorkflowFailure } from "./errors.ts";
export type { WorkflowFailure, WorkflowFailureCode } from "./errors.ts";

export {
  DEFAULT_WORKFLOW_LIMITS,
  MAX_WORKFLOW_LIMITS,
  WORKFLOW_PROTOCOL_VERSION,
  WorkflowRuntimeError,
  WorkflowProtocolMessageSchema,
  WorkflowLimitsSchema,
  type CancelMessage,
  type OperationRequestMessage,
  type OperationResultMessage,
  type StartMessage,
  type TerminalFailureMessage,
  type TerminalSuccessMessage,
  type WorkflowErrorCode,
  type WorkflowLimits,
  type WorkflowLimitsInput,
  type WorkflowOperation,
  type WorkflowOperationHandler,
  type WorkflowProtocolMessage,
  type WorkflowResult,
  parseProtocolLine,
  serializeProtocolMessage,
  toWireLimits,
} from "./protocol.ts";
export { runWorkflowChild } from "./child.ts";

export type EvaluateWorkflowInput = Readonly<{
  readonly source: string;
  readonly args: unknown;
  readonly cwd: string;
  readonly runtime?: unknown;
  readonly limits?: WorkflowLimitsInput;
  readonly signal?: AbortSignal;
  readonly operationHandler: WorkflowOperationHandler;
  /** Test-only child injection; production always uses the Bun subprocess path below. */
  readonly testChildSpawner?: WorkflowChildSpawner;
}>;

const SOURCE_CHILD_ENTRYPOINT = fileURLToPath(new URL("./child.ts", import.meta.url));
const MAX_STDERR_DIAGNOSTIC_BYTES = 2_048;
const SAFE_PROCESS_ERROR_CODES = new Set([
  "EACCES",
  "EINTR",
  "EINVAL",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "EPERM",
  "ETXTBSY",
]);

type BunResolution = "current" | "path" | "unavailable";
type ChildLaunchStage = "resolve" | "spawn";
type ChildReadable =
  | AsyncIterable<Uint8Array<ArrayBufferLike>>
  | ReadableStream<Uint8Array<ArrayBuffer>>;
type ProcessExit = Readonly<{
  readonly exitCode: number | null;
  readonly errorCode: string | null;
}>;
export type WorkflowChildProcess = Readonly<{
  readonly stdout: ChildReadable | null;
  readonly stderr: ChildReadable | null;
  readonly exited: Promise<ProcessExit>;
  readonly writeLine: (line: string) => Promise<void>;
  readonly kill: () => void;
}>;
export type WorkflowChildSpawner = (
  executable: string,
  entrypoint: string,
  cwd: string,
) => WorkflowChildProcess;
type ProcessHandle = WorkflowChildProcess;
type StderrDiagnostic = Readonly<{
  readonly byteCount: number;
  readonly truncated: boolean;
  readonly kind: "none" | "not_found" | "permission_denied" | "module_load" | "other";
}>;

export async function evaluateWorkflow(input: EvaluateWorkflowInput): Promise<WorkflowResult> {
  let limits: WorkflowLimits;
  let args: JsonValue;
  let runtime: JsonValue;
  try {
    limits = mergeWorkflowLimits(input.limits);
    ({ args, runtime } = validateInput(input, limits));
  } catch (error) {
    return failure(toWorkflowError(error, "invalid_input", "Invalid workflow input."));
  }
  if (input.signal?.aborted) {
    return failure(new WorkflowRuntimeError("cancelled", "The workflow was cancelled."));
  }

  let processHandle: ProcessHandle;
  let bunResolution: BunResolution = "unavailable";
  let launchStage: ChildLaunchStage = "resolve";
  try {
    if (input.testChildSpawner) {
      bunResolution = "current";
      launchStage = "spawn";
      processHandle = input.testChildSpawner("bun", SOURCE_CHILD_ENTRYPOINT, input.cwd);
    } else {
      const executable = await resolveBunExecutable();
      bunResolution = executable.resolution;
      launchStage = "spawn";
      processHandle = spawnChild(executable.path, input.cwd);
    }
  } catch (error) {
    return failure(childLaunchFailure(launchStage, bunResolution, error));
  }

  const startMessage = {
    version: 1 as const,
    type: "start" as const,
    source: input.source,
    args,
    runtime,
    limits: toWireLimits(limits),
  };

  try {
    await writeProcessLine(processHandle, serializeProtocolMessage(startMessage, limits));
  } catch {
    processHandle.kill();
    return failure(
      new WorkflowRuntimeError("child_crashed", "The workflow child could not receive input."),
    );
  }

  return await monitorChild(processHandle, input, limits);
}

/** Explicit compatibility name for the isolated QuickJS/string evaluator. */
export function evaluateWorkflowCompatibility(
  input: EvaluateWorkflowInput,
): Promise<WorkflowResult> {
  return evaluateWorkflow(input);
}

function validateInput(
  input: EvaluateWorkflowInput,
  limits: WorkflowLimits,
): { readonly args: JsonValue; readonly runtime: JsonValue } {
  if (typeof input.source !== "string") {
    throw new WorkflowRuntimeError("invalid_input", "The workflow source must be text.", {
      field: "source",
    });
  }
  if (new TextEncoder().encode(input.source).byteLength > limits.maxSourceBytes) {
    throw new WorkflowRuntimeError("resource_limit", "The workflow source is too large.", {
      field: "source",
    });
  }
  if (typeof input.cwd !== "string" || input.cwd.length === 0 || !isAbsolutePath(input.cwd)) {
    throw new WorkflowRuntimeError("invalid_input", "The workflow cwd must be absolute.", {
      field: "cwd",
    });
  }
  if (typeof input.operationHandler !== "function") {
    throw new WorkflowRuntimeError("invalid_input", "The workflow operation handler is required.", {
      field: "operationHandler",
    });
  }
  const args = validateJsonValue(input.args, limits, "args");
  const runtime = validateJsonValue(input.runtime ?? {}, limits, "runtime");
  const startBytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      type: "start",
      source: input.source,
      args,
      runtime,
      limits: toWireLimits(limits),
    }),
  ).byteLength;
  if (startBytes + 1 > limits.maxLineBytes) {
    throw new WorkflowRuntimeError("resource_limit", "The workflow start message is too large.");
  }
  return { args, runtime };
}

async function monitorChild(
  processHandle: ProcessHandle,
  input: EvaluateWorkflowInput,
  limits: WorkflowLimits,
): Promise<WorkflowResult> {
  return await new Promise<WorkflowResult>((resolve) => {
    let settled = false;
    let operationCount = 0;
    const outstanding = new Map<string, Promise<void>>();
    const timer = setTimeout(() => {
      void sendCancellation(processHandle, limits, "timed_out");
      finish(failure(new WorkflowRuntimeError("timed_out", "The workflow timed out.")));
    }, limits.wallTimeMs);

    const abortListener = (): void => {
      void sendCancellation(processHandle, limits, "cancelled");
      finish(failure(new WorkflowRuntimeError("cancelled", "The workflow was cancelled.")));
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });

    const finish = (result: WorkflowResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortListener);
      try {
        processHandle.kill();
      } catch {
        // The child may already have exited after emitting its terminal message.
      }
      resolve(result);
    };

    if (input.signal?.aborted) {
      abortListener();
      return;
    }

    const stderrDiagnostics = captureStderr(processHandle.stderr);

    const stdout = processHandle.stdout;
    if (stdout === undefined || typeof stdout === "number") {
      finish(
        failure(
          new WorkflowRuntimeError("child_crashed", "The workflow child output is unavailable."),
        ),
      );
      return;
    }
    void consumeStream(stdout, limits, (line) => {
      if (settled) {
        return;
      }
      let message: WorkflowProtocolMessage;
      try {
        message = parseProtocolLine(line, limits);
      } catch (error) {
        finish(failure(toWorkflowError(error, "protocol_breach", "The workflow protocol failed.")));
        return;
      }
      if (message.type === "operation-request") {
        if (operationCount >= limits.maxOperationCount) {
          finish(
            failure(
              new WorkflowRuntimeError(
                "resource_limit",
                "The workflow operation limit was exceeded.",
              ),
            ),
          );
          return;
        }
        if (outstanding.size >= limits.maxConcurrentOperations) {
          finish(
            failure(
              new WorkflowRuntimeError(
                "resource_limit",
                "The workflow concurrency limit was exceeded.",
              ),
            ),
          );
          return;
        }
        if (outstanding.has(message.request_id)) {
          finish(
            failure(
              new WorkflowRuntimeError(
                "protocol_breach",
                "The child reused a workflow operation request id.",
              ),
            ),
          );
          return;
        }
        operationCount += 1;
        const task = serviceOperation(processHandle, message, input.operationHandler, limits)
          .catch(() => {
            finish(
              failure(
                new WorkflowRuntimeError(
                  "protocol_breach",
                  "The workflow operation response failed.",
                ),
              ),
            );
          })
          .finally(() => {
            outstanding.delete(message.request_id);
          });
        outstanding.set(message.request_id, task);
        return;
      }
      if (message.type === "terminal-success") {
        try {
          const value = validateJsonValue(message.result, limits, "result");
          finish({ ok: true, value });
        } catch (error) {
          finish(
            failure(toWorkflowError(error, "invalid_result", "The workflow result is invalid.")),
          );
        }
        return;
      }
      if (message.type === "terminal-failure") {
        finish(failure(sanitizeChildError(message)));
        return;
      }
      finish(
        failure(
          new WorkflowRuntimeError("protocol_breach", "The child sent an unexpected message."),
        ),
      );
    }).catch(() => {
      finish(
        failure(
          new WorkflowRuntimeError("protocol_breach", "The workflow child output was malformed."),
        ),
      );
    });

    void processHandle.exited.then(async (exitCode) => {
      if (!settled) {
        const diagnostics = await stderrDiagnostics;
        finish(
          failure(
            new WorkflowRuntimeError(
              "child_crashed",
              "The workflow child exited before completing.",
              {
                exit_code: exitCode.exitCode ?? -1,
                spawn_error_code: exitCode.errorCode ?? "none",
                stderr_bytes: diagnostics.byteCount,
                stderr_truncated: diagnostics.truncated,
                stderr_kind: diagnostics.kind,
              },
            ),
          ),
        );
      }
    });
  });
}

async function serviceOperation(
  processHandle: ProcessHandle,
  message: OperationRequestMessage,
  operationHandler: WorkflowOperationHandler,
  limits: WorkflowLimits,
): Promise<void> {
  const operation: WorkflowOperation = {
    name: "agent",
    prompt: message.input.prompt,
    options: message.input.options,
  };
  try {
    const result = await operationHandler(operation);
    const value = validateJsonValue(result, limits, "result");
    const response: OperationResultMessage = {
      version: 1,
      type: "operation-result",
      request_id: message.request_id,
      ok: true,
      result: value,
    };
    await writeProcessLine(processHandle, serializeProtocolMessage(response, limits));
  } catch {
    const response: OperationResultMessage = {
      version: 1,
      type: "operation-result",
      request_id: message.request_id,
      ok: false,
      error: {
        code: "operation_failed",
        message: "The workflow operation failed.",
      },
    };
    await writeProcessLine(processHandle, serializeProtocolMessage(response, limits));
  }
}

async function sendCancellation(
  processHandle: ProcessHandle,
  limits: WorkflowLimits,
  reason: "cancelled" | "timed_out",
): Promise<void> {
  try {
    await writeProcessLine(
      processHandle,
      serializeProtocolMessage({ version: 1, type: "cancel", reason }, limits),
    );
  } catch {
    // The kill below is the authoritative cancellation boundary.
  }
}

async function writeProcessLine(processHandle: ProcessHandle, line: string): Promise<void> {
  await processHandle.writeLine(line);
}

async function consumeStream(
  stream: ChildReadable | null,
  limits: WorkflowLimits,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) {
    throw new Error("The child stream is unavailable.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      if (new TextEncoder().encode(line).byteLength > limits.maxLineBytes) {
        throw new Error("The child line is too large.");
      }
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf("\n");
    }
    if (new TextEncoder().encode(buffer).byteLength > limits.maxLineBytes) {
      throw new Error("The child line is too large.");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    onLine(buffer.replace(/\r$/u, ""));
  }
}

async function captureStderr(
  stream: ChildReadable | null | number | undefined,
): Promise<StderrDiagnostic> {
  if (stream === undefined || stream === null || typeof stream === "number") {
    return { byteCount: 0, truncated: false, kind: "none" };
  }
  const decoder = new TextDecoder();
  let captured = "";
  let byteCount = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const remaining = MAX_STDERR_DIAGNOSTIC_BYTES - new TextEncoder().encode(captured).byteLength;
    if (remaining > 0) {
      const sample = chunk.subarray(0, remaining);
      captured += decoder.decode(sample, { stream: true });
      if (sample.byteLength < chunk.byteLength) {
        truncated = true;
      }
    } else {
      truncated = true;
    }
    byteCount = Math.min(MAX_STDERR_DIAGNOSTIC_BYTES, byteCount + chunk.byteLength);
  }
  captured += decoder.decode();
  return {
    byteCount,
    truncated,
    kind: classifyStderr(captured),
  };
}

function spawnChild(executable: string, cwd: string): ProcessHandle {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new Error("Bun is required to execute workflow children.");
  }
  const entrypoint = resolveChildEntrypoint();
  const childArguments = isBundledCliEntrypoint(entrypoint)
    ? [entrypoint, "--__holycodex-workflow-child"]
    : [entrypoint];
  const child = Bun.spawn([executable, ...childArguments], {
    cwd,
    env: {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdin = child.stdin;
  return {
    stdout: toReadable(child.stdout),
    stderr: toReadable(child.stderr),
    exited: child.exited.then((exitCode) => ({ exitCode, errorCode: null })),
    writeLine: async (line) => {
      if (stdin === undefined || typeof stdin === "number") {
        throw new Error("The child input stream is unavailable.");
      }
      await stdin.write(line);
    },
    kill: () => child.kill(),
  };
}

function toReadable(stream: Bun.Subprocess["stdout"]): ChildReadable | null {
  if (stream === undefined || typeof stream === "number") {
    return null;
  }
  return stream;
}

async function resolveBunExecutable(): Promise<
  Readonly<{ readonly path: string; readonly resolution: BunResolution }>
> {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new Error("Bun is required to execute workflow children.");
  }
  if (isBunExecutable(process.execPath)) {
    return { path: process.execPath, resolution: "current" };
  }
  const located =
    typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which("bun") : null;
  if (typeof located === "string" && located.length > 0) {
    return { path: located, resolution: "path" };
  }
  throw new Error("Bun executable unavailable.");
}

function isBunExecutable(path: string): boolean {
  const basename = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return basename === "bun" || basename === "bun.exe";
}

function childLaunchFailure(
  stage: ChildLaunchStage,
  resolution: BunResolution,
  error: unknown,
): WorkflowRuntimeError {
  return new WorkflowRuntimeError("child_crashed", "The workflow child could not start.", {
    stage,
    executable: "bun",
    entrypoint: "child.ts",
    resolution,
    error_code: processErrorCode(error),
  });
}

function processErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unknown";
  }
  const code = error.code;
  if (typeof code !== "string") {
    return "unknown";
  }
  return SAFE_PROCESS_ERROR_CODES.has(code) ? code : "other";
}

function resolveChildEntrypoint(): string {
  if (
    typeof Bun !== "undefined" &&
    typeof Bun.main === "string" &&
    /(?:^|[\\/])index\.js$/u.test(Bun.main)
  ) {
    return Bun.main;
  }
  return SOURCE_CHILD_ENTRYPOINT;
}

function isBundledCliEntrypoint(entrypoint: string): boolean {
  return (
    typeof Bun !== "undefined" &&
    typeof Bun.main === "string" &&
    entrypoint === Bun.main &&
    /(?:^|[\\/])index\.js$/u.test(entrypoint)
  );
}

function classifyStderr(stderr: string): StderrDiagnostic["kind"] {
  if (stderr.length === 0) {
    return "none";
  }
  const normalized = stderr.toLowerCase();
  if (/\b(?:enoent|not found|cannot find module)\b/u.test(normalized)) {
    return "not_found";
  }
  if (/\b(?:eacces|eperm|permission denied)\b/u.test(normalized)) {
    return "permission_denied";
  }
  if (/\b(?:unknown file extension|syntaxerror|module load)\b/u.test(normalized)) {
    return "module_load";
  }
  return "other";
}

function sanitizeChildError(message: TerminalFailureMessage): WorkflowRuntimeError {
  const known: ReadonlySet<TerminalFailureMessage["error"]["code"]> = new Set([
    "source_rejected",
    "protocol_breach",
    "timed_out",
    "cancelled",
    "operation_failed",
    "evaluation_failed",
    "interrupted",
    "resource_limit",
    "invalid_result",
    "invalid_input",
    "child_crashed",
  ]);
  const code = known.has(message.error.code) ? message.error.code : "evaluation_failed";
  const messages: Readonly<Record<WorkflowRuntimeError["code"], string>> = {
    invalid_input: "The workflow input is invalid.",
    source_rejected: "The workflow source was rejected.",
    protocol_breach: "The workflow protocol failed.",
    timed_out: "The workflow timed out.",
    cancelled: "The workflow was cancelled.",
    child_crashed: "The workflow child exited unexpectedly.",
    operation_failed: "The workflow operation failed.",
    evaluation_failed: "The workflow evaluation failed.",
    interrupted: "The workflow was interrupted.",
    resource_limit: "The workflow resource limit was exceeded.",
    invalid_result: "The workflow result is invalid.",
  };
  return new WorkflowRuntimeError(code, messages[code]);
}

function failure(error: WorkflowRuntimeError): WorkflowResult {
  return { ok: false, error };
}

function toWorkflowError(
  error: unknown,
  code: "invalid_input" | "protocol_breach" | "invalid_result",
  message: string,
): WorkflowRuntimeError {
  if (error instanceof WorkflowRuntimeError) {
    return error;
  }
  return new WorkflowRuntimeError(code, message);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}
