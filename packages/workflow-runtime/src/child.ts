// SPDX-License-Identifier: Apache-2.0

import {
  newQuickJSWASMModule,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { canonicalJson, type JsonValue } from "@holycodex/core";
import {
  createProtocolFailure,
  DEFAULT_WORKFLOW_LIMITS,
  fromWireLimits,
  MAX_WORKFLOW_LIMITS,
  parseProtocolLine,
  serializeProtocolMessage,
  type OperationRequestMessage,
  type OperationResultMessage,
  type StartMessage,
  type TerminalFailureMessage,
  type TerminalSuccessMessage,
  type WorkflowLimits,
  type WorkflowProtocolMessage,
  validateJsonValue,
  WorkflowRuntimeError,
} from "./protocol.ts";
import { transformWorkflowSource } from "./transform.ts";

type ChildOutboundMessage =
  | OperationRequestMessage
  | TerminalFailureMessage
  | TerminalSuccessMessage;

const QUICKJS_PIPELINE_SOURCE = `
(agent, maxConcurrency) => async (items, options = null) => {
  if (!Array.isArray(items)) throw new TypeError("pipeline items must be an array");
  const concurrency = options === null || options === undefined ? 1 : options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maxConcurrency) {
    throw new RangeError("pipeline concurrency is outside the configured limit");
  }
  const agentOptions = options === null || options === undefined ? null : options.agentOptions ?? null;
  const output = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (typeof item !== "string") throw new TypeError("pipeline items must be strings");
      output[index] = await agent(item, agentOptions);
    }
  };
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return output;
}
`;

class ChildSession {
  private readonly quickjsModule: Awaited<ReturnType<typeof newQuickJSWASMModule>>;
  private readonly limits: WorkflowLimits;
  private readonly deadline: number;
  private readonly deferreds = new Set<QuickJSDeferredPromise>();
  private readonly pendingOperations = new Map<string, QuickJSDeferredPromise>();
  private context:
    | ReturnType<Awaited<ReturnType<typeof newQuickJSWASMModule>>["newContext"]>
    | undefined;
  private runtime:
    | ReturnType<Awaited<ReturnType<typeof newQuickJSWASMModule>>["newRuntime"]>
    | undefined;
  private evaluationPromise: QuickJSHandle | undefined;
  private operationCount = 0;
  private interruptCount = 0;
  private requestCount = 0;
  private operationFailure = false;
  private terminal = false;

  private constructor(
    quickjsModule: Awaited<ReturnType<typeof newQuickJSWASMModule>>,
    limits: WorkflowLimits,
  ) {
    this.quickjsModule = quickjsModule;
    this.limits = limits;
    this.deadline = Date.now() + limits.wallTimeMs;
  }

  static async createWithModule(
    start: StartMessage,
    quickjsModule: Awaited<ReturnType<typeof newQuickJSWASMModule>>,
  ): Promise<ChildSession> {
    const limits = fromWireLimits(start.limits);
    validateJsonValue(start.args, limits, "args");
    validateJsonValue(start.runtime, limits, "runtime");
    const session = new ChildSession(quickjsModule, limits);
    session.initialize(start);
    return session;
  }

  receive(message: WorkflowProtocolMessage): void {
    if (this.terminal) {
      return;
    }
    if (message.type === "operation-result") {
      this.receiveOperationResult(message);
      return;
    }
    if (message.type === "cancel") {
      this.finishFailure(
        new WorkflowRuntimeError(
          message.reason === "timed_out" ? "timed_out" : "cancelled",
          message.reason === "timed_out"
            ? "The workflow timed out."
            : "The workflow was cancelled.",
        ),
      );
      return;
    }
    throw new WorkflowRuntimeError("protocol_breach", "The child received an unexpected message.");
  }

  finishAtEof(
    error = new WorkflowRuntimeError("child_crashed", "The workflow child closed early."),
  ): void {
    if (!this.terminal) {
      this.finishFailure(error);
    }
    this.dispose();
  }

  private initialize(start: StartMessage): void {
    let transformed: string;
    try {
      transformed = transformWorkflowSource(start.source, this.limits.maxSourceBytes);
    } catch (error) {
      this.finishFailure(
        toWorkflowError(error, "source_rejected", "The workflow source was rejected."),
      );
      return;
    }

    try {
      const runtime = this.quickjsModule.newRuntime();
      this.runtime = runtime;
      runtime.setMemoryLimit(this.limits.memoryLimitBytes);
      runtime.setMaxStackSize(this.limits.stackLimitBytes);
      runtime.setInterruptHandler(() => {
        this.interruptCount += 1;
        return this.interruptCount > this.limits.maxInterrupts || Date.now() >= this.deadline;
      });
      const context = runtime.newContext();
      this.context = context;
      const operationFunction = context.newFunction("__workflowAgent", (...args) =>
        this.startOperation(args),
      );
      const argsHandle = this.jsonHandle(start.args);
      const runtimeHandle = this.jsonHandle(start.runtime);
      this.deleteRestrictedGlobals();
      this.deepFreeze(argsHandle);
      this.deepFreeze(runtimeHandle);

      const pipelineFactoryResult = context.evalCode(QUICKJS_PIPELINE_SOURCE);
      if (pipelineFactoryResult.error) {
        pipelineFactoryResult.error.dispose();
        throw new WorkflowRuntimeError(
          "evaluation_failed",
          "The workflow pipeline could not be prepared.",
        );
      }
      const pipelineFactory = pipelineFactoryResult.value;
      const maxConcurrencyHandle = context.newNumber(this.limits.maxConcurrentOperations);
      const pipelineResult = context.callFunction(
        pipelineFactory,
        context.undefined,
        operationFunction,
        maxConcurrencyHandle,
      );
      pipelineFactory.dispose();
      maxConcurrencyHandle.dispose();
      if (pipelineResult.error) {
        pipelineResult.error.dispose();
        throw new WorkflowRuntimeError(
          "evaluation_failed",
          "The workflow pipeline could not be prepared.",
        );
      }
      const pipelineFunction = pipelineResult.value;

      const workflowResult = context.evalCode(transformed);
      if (workflowResult.error) {
        workflowResult.error.dispose();
        throw new WorkflowRuntimeError("evaluation_failed", "The workflow could not be evaluated.");
      }
      const workflowFunction = context.getProp(context.global, "__workflow");
      const deleteWorkflowResult = context.evalCode("delete globalThis.__workflow");
      if (deleteWorkflowResult.error) {
        deleteWorkflowResult.error.dispose();
        workflowResult.value.dispose();
        workflowFunction.dispose();
        throw new WorkflowRuntimeError("evaluation_failed", "The workflow could not be prepared.");
      }
      deleteWorkflowResult.value.dispose();
      workflowResult.value.dispose();
      const result = context.callFunction(
        workflowFunction,
        context.undefined,
        argsHandle,
        runtimeHandle,
        operationFunction,
        pipelineFunction,
      );
      workflowFunction.dispose();
      operationFunction.dispose();
      pipelineFunction.dispose();
      argsHandle.dispose();
      runtimeHandle.dispose();
      if (result.error) {
        result.error.dispose();
        this.finishFailure(this.evaluationError());
        return;
      }
      this.evaluationPromise = result.value;
      this.driveJobs();
    } catch (error) {
      this.finishFailure(
        toWorkflowError(error, "evaluation_failed", "The workflow could not be evaluated."),
      );
    }
  }

  private deleteRestrictedGlobals(): void {
    const context = this.requireContext();
    const result = context.evalCode(`
      (() => {
        const constructors = [
          globalThis.Function,
          Object.getPrototypeOf(async function () {}).constructor,
          Object.getPrototypeOf(function* () {}).constructor,
          Object.getPrototypeOf(async function* () {}).constructor,
        ];
        for (const constructor of constructors) {
          const prototype = constructor?.prototype;
          if (prototype && Object.prototype.hasOwnProperty.call(prototype, "constructor")) {
            Object.defineProperty(prototype, "constructor", {
              value: undefined,
              configurable: false,
              enumerable: false,
              writable: false,
            });
          }
        }
      })();
      delete globalThis.Bun;
      delete globalThis.process;
      delete globalThis.fetch;
      delete globalThis.require;
      delete globalThis.eval;
      delete globalThis.Function;
      delete globalThis.WebAssembly;
    `);
    if (result.error) {
      result.error.dispose();
      throw new WorkflowRuntimeError(
        "evaluation_failed",
        "The restricted globals could not be removed.",
      );
    }
    result.value.dispose();
  }

  private deepFreeze(value: QuickJSHandle): void {
    const context = this.requireContext();
    const freezerResult = context.evalCode(`
      (value => {
        const freeze = (current, seen = new Set()) => {
          if (current !== null && typeof current === "object" && !seen.has(current)) {
            seen.add(current);
            for (const key of Reflect.ownKeys(current)) freeze(current[key], seen);
            Object.freeze(current);
          }
          return current;
        };
        return freeze(value);
      })
    `);
    if (freezerResult.error) {
      freezerResult.error.dispose();
      throw new WorkflowRuntimeError(
        "evaluation_failed",
        "The workflow input could not be prepared.",
      );
    }
    const freezer = freezerResult.value;
    const frozenResult = context.callFunction(freezer, context.undefined, value);
    freezer.dispose();
    if (frozenResult.error) {
      frozenResult.error.dispose();
      throw new WorkflowRuntimeError(
        "evaluation_failed",
        "The workflow input could not be prepared.",
      );
    }
    frozenResult.value.dispose();
  }

  private startOperation(args: readonly QuickJSHandle[]): QuickJSHandle {
    const context = this.requireContext();
    const promptHandle = args[0];
    const optionsHandle = args[1] ?? context.null;
    if (
      args.length < 1 ||
      args.length > 2 ||
      !promptHandle ||
      this.operationCount >= this.limits.maxOperationCount
    ) {
      throw new Error("The workflow operation limit was exceeded.");
    }
    if (this.pendingOperations.size >= this.limits.maxConcurrentOperations) {
      throw new Error("The workflow concurrency limit was exceeded.");
    }
    let prompt: string;
    let parsedOptions: JsonValue;
    try {
      prompt = context.getString(promptHandle);
      parsedOptions = validateJsonValue(
        context.dump(optionsHandle),
        this.limits,
        "operation options",
      );
    } catch {
      throw new Error("The workflow operation arguments are invalid.");
    }
    this.operationCount += 1;
    this.requestCount += 1;
    const requestId = `op-${this.requestCount}`;
    const deferred = context.newPromise();
    this.deferreds.add(deferred);
    this.pendingOperations.set(requestId, deferred);
    try {
      this.send({
        version: 1,
        type: "operation-request",
        request_id: requestId,
        operation: "agent",
        input: {
          prompt,
          options: parsedOptions,
        },
      });
    } catch {
      this.pendingOperations.delete(requestId);
      const errorHandle = context.newError("The workflow operation could not be sent.");
      deferred.reject(errorHandle);
      errorHandle.dispose();
    }
    return deferred.handle;
  }

  private receiveOperationResult(message: OperationResultMessage): void {
    const deferred = this.pendingOperations.get(message.request_id);
    if (!deferred) {
      throw new WorkflowRuntimeError(
        "protocol_breach",
        "The operation result does not match a request.",
      );
    }
    this.pendingOperations.delete(message.request_id);
    const context = this.requireContext();
    if (message.ok) {
      if (!("result" in message)) {
        throw new WorkflowRuntimeError("protocol_breach", "The operation result is incomplete.");
      }
      let value: QuickJSHandle;
      try {
        value = this.jsonHandle(message.result);
      } catch {
        throw new WorkflowRuntimeError("protocol_breach", "The operation result is invalid.");
      }
      deferred.resolve(value);
      value.dispose();
    } else {
      if (!("error" in message)) {
        throw new WorkflowRuntimeError("protocol_breach", "The operation failure is incomplete.");
      }
      const errorHandle = context.newError("The workflow operation failed.");
      this.operationFailure = true;
      deferred.reject(errorHandle);
      errorHandle.dispose();
    }
    this.driveJobs();
  }

  private jsonHandle(value: JsonValue): QuickJSHandle {
    const context = this.requireContext();
    validateJsonValue(value, this.limits, "operation result");
    const result = context.evalCode(`JSON.parse(${JSON.stringify(canonicalJson(value))})`);
    if (result.error) {
      result.error.dispose();
      throw new Error("Invalid JSON result.");
    }
    return result.value;
  }

  private driveJobs(): void {
    const runtime = this.requireRuntime();
    const context = this.requireContext();
    try {
      while (runtime.hasPendingJob()) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          jobs.dispose();
          this.finishFailure(this.evaluationError());
          return;
        }
        jobs.dispose();
      }
      const promise = this.evaluationPromise;
      if (!promise || this.terminal) {
        return;
      }
      const state = context.getPromiseState(promise);
      if (state.type === "pending") {
        return;
      }
      if (state.type === "rejected") {
        state.error.dispose();
        this.finishFailure(this.evaluationError());
        return;
      }
      const dumped = context.dump(state.value);
      state.value.dispose();
      const result = validateJsonValue(dumped, this.limits, "result");
      const resultBytes = new TextEncoder().encode(canonicalJson(result)).byteLength;
      if (resultBytes > this.limits.maxResultBytes) {
        this.finishFailure(
          new WorkflowRuntimeError("resource_limit", "The workflow result is too large."),
        );
        return;
      }
      this.finishSuccess(result);
    } catch (error) {
      this.finishFailure(toWorkflowError(error, "evaluation_failed", "The workflow failed."));
    }
  }

  private finishSuccess(result: JsonValue): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    try {
      this.send({ version: 1, type: "terminal-success", result });
    } finally {
      this.dispose();
    }
  }

  private finishFailure(error: WorkflowRuntimeError): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    try {
      this.send(createProtocolFailure(error));
    } finally {
      this.dispose();
    }
  }

  private send(message: ChildOutboundMessage): void {
    const line = serializeProtocolMessage(message, this.limits);
    process.stdout.write(line);
  }

  private evaluationError(): WorkflowRuntimeError {
    if (this.operationFailure) {
      return new WorkflowRuntimeError("operation_failed", "The workflow operation failed.");
    }
    if (this.interruptCount > this.limits.maxInterrupts || Date.now() >= this.deadline) {
      return new WorkflowRuntimeError(
        Date.now() >= this.deadline ? "timed_out" : "interrupted",
        Date.now() >= this.deadline ? "The workflow timed out." : "The workflow was interrupted.",
      );
    }
    return new WorkflowRuntimeError("evaluation_failed", "The workflow evaluation failed.");
  }

  private requireContext(): NonNullable<ChildSession["context"]> {
    if (!this.context) {
      throw new WorkflowRuntimeError("evaluation_failed", "The workflow context is unavailable.");
    }
    return this.context;
  }

  private requireRuntime(): NonNullable<ChildSession["runtime"]> {
    if (!this.runtime) {
      throw new WorkflowRuntimeError("evaluation_failed", "The workflow runtime is unavailable.");
    }
    return this.runtime;
  }

  private dispose(): void {
    this.evaluationPromise?.dispose();
    this.evaluationPromise = undefined;
    for (const deferred of this.deferreds) {
      deferred.dispose();
    }
    this.deferreds.clear();
    this.pendingOperations.clear();
    try {
      this.context?.dispose();
    } catch {
      // The child is already terminal; never leak a host error into the protocol.
    }
    this.context = undefined;
    try {
      this.runtime?.dispose();
    } catch {
      // The child is already terminal; never leak a host error into the protocol.
    }
    this.runtime = undefined;
  }
}

export async function runWorkflowChild(): Promise<void> {
  const quickjsModulePromise = newQuickJSWASMModule();
  let session: ChildSession | undefined;
  try {
    for await (const line of readLines()) {
      const message = parseProtocolLine(line, MAX_WORKFLOW_LIMITS);
      if (!session) {
        if (message.type !== "start") {
          throw new WorkflowRuntimeError("protocol_breach", "The child expected a start message.");
        }
        const quickjsModule = await quickjsModulePromise;
        session = await ChildSession.createWithModule(message, quickjsModule);
        continue;
      }
      session.receive(message);
    }
    session?.finishAtEof();
  } catch (error) {
    if (session) {
      session.finishAtEof(
        toWorkflowError(error, "protocol_breach", "The workflow protocol failed."),
      );
    } else {
      const message = createProtocolFailure(
        toWorkflowError(error, "protocol_breach", "The workflow protocol failed."),
      );
      process.stdout.write(serializeProtocolMessage(message, DEFAULT_WORKFLOW_LIMITS));
    }
    process.exitCode = 1;
  }
}

async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    if (new TextEncoder().encode(buffer).byteLength > MAX_WORKFLOW_LIMITS.maxLineBytes) {
      throw new WorkflowRuntimeError("protocol_breach", "The workflow protocol line is too large.");
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      yield line;
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer.replace(/\r$/u, "");
  }
}

function toWorkflowError(
  error: unknown,
  fallbackCode: "source_rejected" | "evaluation_failed" | "protocol_breach",
  fallbackMessage: string,
): WorkflowRuntimeError {
  if (error instanceof WorkflowRuntimeError) {
    return error;
  }
  return new WorkflowRuntimeError(fallbackCode, fallbackMessage);
}

if (import.meta.main) {
  void runWorkflowChild();
}
