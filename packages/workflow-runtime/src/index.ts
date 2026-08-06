import { newAsyncContext, type QuickJSAsyncContext, type QuickJSHandle } from "quickjs-emscripten";
import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type AgentOptions = {
  readonly callId?: number;
  readonly agent?: string;
  readonly stage?: string;
  readonly label?: string;
  readonly phase?: string;
  readonly context?: JsonValue;
  readonly schema?: JsonSchema;
  readonly retries?: number;
};

export type AgentExecutor = (
  prompt: string,
  options: AgentOptions,
) => JsonValue | Promise<JsonValue>;

export type PipelineOptions = {
  readonly concurrency?: number;
  readonly label?: string;
  readonly phase?: string;
};

export type WorkflowLimits = {
  readonly maxCalls?: number;
  readonly maxRetries?: number;
  readonly maxConcurrency?: number;
  readonly maxMemoryBytes?: number;
  readonly maxStackBytes?: number;
  readonly maxScriptBytes?: number;
  readonly maxFanOut?: number;
  readonly maxLoopIterations?: number;
};

export type WorkflowEvent =
  | { readonly type: "workflow-start"; readonly scriptBytes: number }
  | {
      readonly type: "call-start";
      readonly callId: number;
      readonly label?: string;
      readonly phase?: string;
    }
  | {
      readonly type: "call-complete";
      readonly callId: number;
      readonly attempt: number;
      readonly label?: string;
      readonly phase?: string;
    }
  | {
      readonly type: "call-error";
      readonly callId: number;
      readonly attempt: number;
      readonly label?: string;
      readonly phase?: string;
      readonly error: string;
    }
  | {
      readonly type: "call-failed";
      readonly callId: number;
      readonly attempts: number;
      readonly label?: string;
      readonly phase?: string;
    }
  | { readonly type: "workflow-complete"; readonly calls: number; readonly errors: number };

export type WorkflowInput = {
  readonly script: string;
  readonly args?: JsonValue;
  readonly executor: AgentExecutor;
  readonly signal?: AbortSignal;
  readonly limits?: WorkflowLimits;
  readonly onEvent?: (event: WorkflowEvent) => void;
};

export type WorkflowResult = {
  readonly result: JsonValue;
  readonly meta: JsonValue | null;
  readonly events: readonly WorkflowEvent[];
  readonly errors: readonly string[];
};

export type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly properties?: { readonly [key: string]: JsonSchema };
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly additionalProperties?: boolean;
};

const DEFAULT_LIMITS: Required<WorkflowLimits> = {
  maxCalls: 100,
  maxRetries: 2,
  maxConcurrency: 8,
  maxMemoryBytes: 16 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
  maxScriptBytes: 64 * 1024,
  maxFanOut: 8,
  maxLoopIterations: 1_000,
};

const jsonSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      type: z.union([z.string(), z.array(z.string())]).optional(),
      properties: z.record(z.string(), jsonSchema).optional(),
      required: z.array(z.string()).optional(),
      items: jsonSchema.optional(),
      enum: z.array(z.unknown()).optional(),
      const: z.unknown().optional(),
      additionalProperties: z.boolean().optional(),
    })
    .passthrough(),
);

const agentOptions = z
  .object({
    agent: z.string().min(1).max(100).optional(),
    stage: z.string().min(1).max(100).optional(),
    label: z.string().max(200).optional(),
    phase: z.string().max(200).optional(),
    context: z.unknown().optional(),
    schema: jsonSchema.optional(),
    retries: z.number().int().min(0).max(20).optional(),
  })
  .strict();

const pipelineOptions = z
  .object({
    concurrency: z.number().int().min(1).max(100).optional(),
    label: z.string().max(200).optional(),
    phase: z.string().max(200).optional(),
  })
  .strict();

const agentDescriptor = z.object({
  __agent: z.literal(true),
  prompt: z.string(),
  options: agentOptions,
});

const workflowLimits = z
  .object({
    maxCalls: z.number().int().min(1).max(10_000).optional(),
    maxRetries: z.number().int().min(0).max(20).optional(),
    maxConcurrency: z.number().int().min(1).max(100).optional(),
    maxMemoryBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(512 * 1024 * 1024)
      .optional(),
    maxStackBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(64 * 1024 * 1024)
      .optional(),
    maxScriptBytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024)
      .optional(),
    maxFanOut: z.number().int().min(1).max(1_000).optional(),
    maxLoopIterations: z.number().int().min(1).max(1_000_000).optional(),
  })
  .passthrough();

const PRELUDE = `
const { agent, pipeline } = (() => {
const __g = globalThis;
const __hostAgent = __g.__hostAgent;
const __hostPipeline = __g.__hostPipeline;
delete __g.__hostAgent;
delete __g.__hostPipeline;
for (const __prototype of [
  __g.Object.prototype,
  __g.Function.prototype,
  __g.Array.prototype,
  __g.Number.prototype,
  __g.String.prototype,
]) Object.defineProperty(__prototype, "constructor", { value: undefined, configurable: false });
Object.defineProperty(__g, "globalThis", { value: undefined, configurable: false });
Object.defineProperty(__g, "eval", { value: undefined, configurable: false });
Object.defineProperty(__g, "Function", { value: undefined, configurable: false });
Object.defineProperty(__g, "process", { value: undefined, configurable: false });
Object.defineProperty(__g, "require", { value: undefined, configurable: false });
Object.defineProperty(__g, "fetch", { value: undefined, configurable: false });
Object.defineProperty(__g, "Deno", { value: undefined, configurable: false });
let __pipelineMode = false;
const agent = (prompt, options = {}) => {
  if (__pipelineMode) return { __agent: true, prompt, options };
  return JSON.parse(__hostAgent(prompt, options));
};
const pipeline = (items, callback, options = {}) => {
  if (!Array.isArray(items) || typeof callback !== "function") throw new TypeError("pipeline requires an array and callback");
  const descriptors = [];
  __pipelineMode = true;
  try {
    for (let index = 0; index < items.length; index += 1) descriptors.push(callback(items[index], index));
  } finally {
    __pipelineMode = false;
  }
  return JSON.parse(__hostPipeline(JSON.stringify(descriptors), JSON.stringify(options)));
};
return { agent, pipeline };
})();
`;

/** Executes a model-authored workflow in an isolated QuickJS WebAssembly context. */
export async function runWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  validateInput(input);
  const parsedLimits = workflowLimits.safeParse(input.limits ?? {});
  if (!parsedLimits.success) throw new TypeError("Invalid workflow limits.");
  const limits: Required<WorkflowLimits> = {
    maxCalls: parsedLimits.data.maxCalls ?? DEFAULT_LIMITS.maxCalls,
    maxRetries: parsedLimits.data.maxRetries ?? DEFAULT_LIMITS.maxRetries,
    maxConcurrency: parsedLimits.data.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
    maxMemoryBytes: parsedLimits.data.maxMemoryBytes ?? DEFAULT_LIMITS.maxMemoryBytes,
    maxStackBytes: parsedLimits.data.maxStackBytes ?? DEFAULT_LIMITS.maxStackBytes,
    maxScriptBytes: parsedLimits.data.maxScriptBytes ?? DEFAULT_LIMITS.maxScriptBytes,
    maxFanOut: parsedLimits.data.maxFanOut ?? DEFAULT_LIMITS.maxFanOut,
    maxLoopIterations: parsedLimits.data.maxLoopIterations ?? DEFAULT_LIMITS.maxLoopIterations,
  };
  const scriptBytes = new TextEncoder().encode(input.script).byteLength;
  if (scriptBytes > limits.maxScriptBytes)
    throw new RangeError("Workflow script exceeds maxScriptBytes.");

  const events: WorkflowEvent[] = [];
  const errors: string[] = [];
  const emit = (event: WorkflowEvent): void => {
    events.push(event);
    input.onEvent?.(event);
  };
  emit({ type: "workflow-start", scriptBytes });

  const context = await newAsyncContext({
    intrinsics: { Eval: false },
  });
  context.runtime.setMemoryLimit(limits.maxMemoryBytes);
  context.runtime.setMaxStackSize(limits.maxStackBytes);
  let calls = 0;
  let disposed = false;
  const dispose = (): void => {
    if (!disposed) {
      disposed = true;
      context.dispose();
    }
  };
  let executionChecks = 0;
  const isCancelled = (): boolean => input.signal?.aborted === true;
  context.runtime.setInterruptHandler(
    () => isCancelled() || ++executionChecks > limits.maxLoopIterations * 10_000,
  );

  try {
    const executeAgent = async (prompt: string, safeOptions: AgentOptions): Promise<JsonValue> => {
      if (isCancelled()) throw new Error("Workflow cancelled.");
      const callId = ++calls;
      if (calls > limits.maxCalls) throw new Error("Workflow call quota exceeded.");
      emit({
        type: "call-start",
        callId,
        ...(safeOptions.label === undefined ? {} : { label: safeOptions.label }),
        ...(safeOptions.phase === undefined ? {} : { phase: safeOptions.phase }),
      });
      const attempts = Math.min(safeOptions.retries ?? limits.maxRetries, limits.maxRetries) + 1;
      let lastError = "Agent executor failed.";
      let attemptsMade = 0;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        attemptsMade = attempt;
        if (isCancelled()) throw new Error("Workflow cancelled.");
        try {
          const value = await withCancellation(
            Promise.resolve(input.executor(prompt, { ...safeOptions, callId })),
            input.signal,
          );
          if (!isJsonValue(value))
            throw new TypeError("Agent result must be JSON-compatible or null.");
          if (safeOptions.schema !== undefined) assertSchema(value, safeOptions.schema);
          emit({
            type: "call-complete",
            callId,
            attempt,
            ...(safeOptions.label === undefined ? {} : { label: safeOptions.label }),
            ...(safeOptions.phase === undefined ? {} : { phase: safeOptions.phase }),
          });
          return value;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          emit({
            type: "call-error",
            callId,
            attempt,
            ...(safeOptions.label === undefined ? {} : { label: safeOptions.label }),
            ...(safeOptions.phase === undefined ? {} : { phase: safeOptions.phase }),
            error: lastError,
          });
          if (isCancelled()) throw new Error("Workflow cancelled.");
          if (isCancellationError(error)) break;
          if (attempt < attempts) continue;
        }
      }
      errors.push(lastError);
      emit({
        type: "call-failed",
        callId,
        attempts: attemptsMade,
        ...(safeOptions.label === undefined ? {} : { label: safeOptions.label }),
        ...(safeOptions.phase === undefined ? {} : { phase: safeOptions.phase }),
      });
      return null;
    };
    installValue(context, "args", input.args ?? null);
    installFunction(context, "__hostAgent", async (...handles) => {
      const request = parseAgentRequest(context, handles);
      const value = await executeAgent(request.prompt, request.options);
      return context.newString(JSON.stringify(value));
    });
    installFunction(context, "__hostPipeline", async (...handles) => {
      const request = parsePipelineRequest(context, handles);
      if (request.descriptors.length > limits.maxFanOut)
        throw new Error("Workflow pipeline fan-out quota exceeded.");
      const concurrency = Math.min(request.options.concurrency ?? 1, limits.maxConcurrency);
      const values = await runBounded(request.descriptors, concurrency, async (descriptor) =>
        executeAgent(descriptor.prompt, {
          ...descriptor.options,
          ...(descriptor.options.label === undefined && request.options.label !== undefined
            ? { label: request.options.label }
            : {}),
          ...(descriptor.options.phase === undefined && request.options.phase !== undefined
            ? { phase: request.options.phase }
            : {}),
        }),
      );
      return context.newString(JSON.stringify(values));
    });

    const source = `${PRELUDE}\n${moduleSource(input.script)}`;
    const evaluated = await withCancellation(
      context.evalCodeAsync(source, "workflow.js", { type: "module", strict: true }),
      input.signal,
    );
    drainPendingJobs(context, input.signal);
    const namespace = context.unwrapResult(evaluated);
    const exported = dumpModuleResult(context, namespace);
    namespace.dispose();
    const object = isRecord(exported) ? exported : {};
    const result = isJsonValue(object.default)
      ? object.default
      : isJsonValue(exported)
        ? exported
        : null;
    const meta = isJsonValue(object.meta) ? object.meta : null;
    emit({ type: "workflow-complete", calls, errors: errors.length });
    return { result, meta, events, errors };
  } finally {
    dispose();
  }
}

/** Alias for runWorkflow for callers that prefer an execute verb. */
export const executeWorkflow = runWorkflow;

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && /cancel|interrupt|stopp?ed/i.test(error.message);
}

function installValue(context: QuickJSAsyncContext, name: string, value: JsonValue): void {
  const parsed = context.unwrapResult(
    context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`),
  );
  context.setProp(context.global, name, parsed);
  parsed.dispose();
}

function installFunction(
  context: QuickJSAsyncContext,
  name: string,
  fn: (...handles: QuickJSHandle[]) => Promise<QuickJSHandle>,
): void {
  const handle = context.newAsyncifiedFunction(name, fn);
  context.setProp(context.global, name, handle);
  handle.dispose();
}

type AgentRequest = { readonly prompt: string; readonly options: AgentOptions };
type AgentDescriptor = AgentRequest & { readonly __agent: true };

function parseAgentRequest(
  context: QuickJSAsyncContext,
  handles: readonly QuickJSHandle[],
): AgentRequest {
  const promptHandle = handles[0];
  if (promptHandle === undefined) throw new TypeError("agent requires a prompt.");
  const prompt = context.dump(promptHandle);
  const options = handles[1] === undefined ? {} : context.dump(handles[1]);
  const parsedPrompt = z.string().safeParse(prompt);
  const parsedOptions = agentOptions.safeParse(options);
  if (!parsedPrompt.success || !parsedOptions.success)
    throw new TypeError("Invalid agent request.");
  const safeOptions = parsedOptions.data as AgentOptions;
  if (
    (safeOptions.context !== undefined && !isJsonValue(safeOptions.context)) ||
    (safeOptions.schema !== undefined && !isJsonValue(safeOptions.schema))
  )
    throw new TypeError("Agent options must be JSON-compatible.");
  return { prompt: parsedPrompt.data, options: safeOptions };
}

function parsePipelineRequest(
  context: QuickJSAsyncContext,
  handles: readonly QuickJSHandle[],
): { readonly descriptors: readonly AgentDescriptor[]; readonly options: PipelineOptions } {
  const descriptorsHandle = handles[0];
  const optionsHandle = handles[1];
  if (descriptorsHandle === undefined || optionsHandle === undefined)
    throw new TypeError("pipeline requires descriptors and options.");
  const descriptorsValue = context.dump(descriptorsHandle);
  const optionsValue = context.dump(optionsHandle);
  if (typeof descriptorsValue !== "string" || typeof optionsValue !== "string")
    throw new TypeError("Invalid pipeline request.");
  let descriptorsJson: unknown;
  let optionsJson: unknown;
  try {
    descriptorsJson = JSON.parse(descriptorsValue) as unknown;
    optionsJson = JSON.parse(optionsValue) as unknown;
  } catch {
    throw new TypeError("Invalid pipeline request.");
  }
  const descriptors = z.array(agentDescriptor).safeParse(descriptorsJson);
  const options = pipelineOptions.safeParse(optionsJson);
  if (!descriptors.success || !options.success) throw new TypeError("Invalid pipeline request.");
  return {
    descriptors: descriptors.data as readonly AgentDescriptor[],
    options: options.data as PipelineOptions,
  };
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  execute: (value: T) => Promise<JsonValue>,
): Promise<readonly JsonValue[]> {
  const results: JsonValue[] = Array.from({ length: values.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await execute(value);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker);
  await Promise.all(workers);
  return results;
}

function moduleSource(script: string): string {
  const masked = maskJavaScriptLiterals(script);
  if (/\bexport\s+default\b/.test(masked)) return script;
  const meta = /\bexport\s+const\s+meta\s*=/.exec(masked);
  const body =
    meta?.index === undefined
      ? script
      : `${script.slice(0, meta.index)}__workflowMeta.value =${script.slice(meta.index + meta[0].length)}`;
  return `
const __workflowMeta = { value: null };
const __workflowResult = await (async () => {
${body}
})();
export const meta = __workflowMeta.value;
export default __workflowResult;
`;
}

function maskJavaScriptLiterals(source: string): string {
  let result = "";
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "code") {
      if (current === "/" && next === "/") {
        state = "line";
        result += "  ";
        index += 1;
      } else if (current === "/" && next === "*") {
        state = "block";
        result += "  ";
        index += 1;
      } else if (current === "'") {
        state = "single";
        result += " ";
      } else if (current === '"') {
        state = "double";
        result += " ";
      } else if (current === "`") {
        state = "template";
        result += " ";
      } else result += current;
      continue;
    }
    if (current === "\n" && (state === "line" || state === "single" || state === "double")) {
      if (state === "line") state = "code";
      result += "\n";
      continue;
    }
    if (state === "block" && current === "*" && next === "/") {
      state = "code";
      result += "  ";
      index += 1;
      continue;
    }
    if (
      (state === "single" && current === "'") ||
      (state === "double" && current === '"') ||
      (state === "template" && current === "`")
    )
      state = "code";
    if (current === "\\" && state !== "line" && state !== "block") {
      result += "  ";
      index += 1;
    } else result += current === "\n" ? "\n" : " ";
  }
  return result;
}

function drainPendingJobs(context: QuickJSAsyncContext, signal?: AbortSignal): void {
  while (true) {
    if (signal?.aborted === true) throw new Error("Workflow cancelled.");
    const jobs = context.runtime.executePendingJobs();
    const count = "value" in jobs ? jobs.value : 0;
    jobs.dispose();
    if (count === 0) return;
  }
}

function dumpModuleResult(context: QuickJSAsyncContext, handle: QuickJSHandle): unknown {
  const state = context.getPromiseState(handle);
  if (state.type === "rejected") throw new Error(String(context.dump(state.error)));
  if (state.type === "fulfilled" && state.notAPromise !== true) return context.dump(state.value);
  return context.dump(handle);
}

async function withCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal?.aborted === true) throw new Error("Workflow cancelled.");
  let abort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    const cancel = (): void => reject(new Error("Workflow cancelled."));
    abort = cancel;
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

function validateInput(input: WorkflowInput): void {
  if (typeof input.script !== "string" || typeof input.executor !== "function")
    throw new TypeError("Invalid workflow input.");
  if (input.args !== undefined && !isJsonValue(input.args))
    throw new TypeError("Workflow args must be JSON-compatible.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function assertSchema(value: JsonValue, schema: JsonSchema, path = "$"): void {
  const expected = schema.type;
  if (expected !== undefined) {
    const types = Array.isArray(expected) ? expected : [expected];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const matchesInteger =
      types.includes("integer") && typeof value === "number" && Number.isInteger(value);
    if (!types.includes(actual) && !matchesInteger)
      throw new TypeError(`Agent result does not match schema at ${path}.`);
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => jsonEqual(entry, value)))
    throw new TypeError(`Agent result does not match schema at ${path}.`);
  if (schema.const !== undefined && !jsonEqual(schema.const, value))
    throw new TypeError(`Agent result does not match schema at ${path}.`);
  const itemSchema = schema.items;
  if (Array.isArray(value) && itemSchema !== undefined)
    value.forEach((entry, index) => assertSchema(entry, itemSchema, `${path}[${index}]`));
  if (isRecord(value)) {
    for (const key of schema.required ?? [])
      if (!(key in value))
        throw new TypeError(`Agent result does not match schema at ${path}.${key}.`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const childValue = value[key];
      if (key in value && childValue !== undefined)
        assertSchema(childValue, child, `${path}.${key}`);
    }
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        if (!(key in (schema.properties ?? {})))
          throw new TypeError(`Agent result does not match schema at ${path}.${key}.`);
  }
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonEqual(left[key] as JsonValue, right[key] as JsonValue),
    )
  );
}
