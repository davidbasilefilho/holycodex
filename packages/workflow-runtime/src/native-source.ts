// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  type JsonValue,
} from "@holycodex/core";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { newQuickJSWASMModule, type QuickJSHandle } from "quickjs-emscripten";
import {
  freezeWorkflowPlanIR,
  isJsonValue,
  NATIVE_OUTPUT_REFERENCE_KEY,
  NATIVE_WORKFLOW_ABI_VERSION,
  nativeWorkflowIdentityDigest,
  type NativeWorkflow,
  type NativeWorkflowAssignmentIR,
  type NativeWorkflowCapacityInputsIR,
  type NativeWorkflowCodecIR,
  type NativeWorkflowInputIR,
  type NativeWorkflowNodeIR,
  type NativeWorkflowOutputIR,
  type NativeWorkflowOutputTargetIR,
  type NativeWorkflowTerminalIR,
} from "./native-ir.ts";
import { transformNativeWorkflowSource } from "./transform.ts";
import { WorkflowRuntimeError } from "./protocol.ts";
import { decodePortableSchema, type PortableSchemaIR, type ValueCodec } from "./schema.ts";
import type {
  AssignmentMetadata,
  WorkflowCondition,
  WorkflowPredicate,
  WorkflowRepeatUntil,
} from "./dsl.ts";

const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));
const NativeWorkflowLimitsSchema = Schema.Struct({
  maxSourceBytes: Schema.optional(PositiveIntegerSchema),
  maxTransformedBytes: Schema.optional(PositiveIntegerSchema),
  maxSerializedIRBytes: Schema.optional(PositiveIntegerSchema),
  maxPlanNodes: Schema.optional(PositiveIntegerSchema),
  maxCodecCalls: Schema.optional(PositiveIntegerSchema),
  maxCodecBytes: Schema.optional(PositiveIntegerSchema),
  maxJsonDepth: Schema.optional(PositiveIntegerSchema),
  maxObjectKeys: Schema.optional(PositiveIntegerSchema),
  maxArrayItems: Schema.optional(PositiveIntegerSchema),
  maxStringBytes: Schema.optional(PositiveIntegerSchema),
  wallTimeMs: Schema.optional(PositiveIntegerSchema),
  memoryLimitBytes: Schema.optional(PositiveIntegerSchema),
  stackLimitBytes: Schema.optional(PositiveIntegerSchema),
  maxInterrupts: Schema.optional(PositiveIntegerSchema),
});

export type NativeWorkflowLimits = Readonly<{
  readonly maxSourceBytes: number;
  readonly maxTransformedBytes: number;
  readonly maxSerializedIRBytes: number;
  readonly maxPlanNodes: number;
  readonly maxCodecCalls: number;
  readonly maxCodecBytes: number;
  readonly maxJsonDepth: number;
  readonly maxObjectKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringBytes: number;
  readonly wallTimeMs: number;
  readonly memoryLimitBytes: number;
  readonly stackLimitBytes: number;
  readonly maxInterrupts: number;
}>;

export type NativeWorkflowLimitsInput = Partial<NativeWorkflowLimits>;

export const DEFAULT_NATIVE_WORKFLOW_LIMITS: NativeWorkflowLimits = Object.freeze({
  maxSourceBytes: 256 * 1024,
  maxTransformedBytes: 512 * 1024,
  maxSerializedIRBytes: 512 * 1024,
  maxPlanNodes: 1_024,
  maxCodecCalls: 4_096,
  maxCodecBytes: 256 * 1024,
  maxJsonDepth: 32,
  maxObjectKeys: 256,
  maxArrayItems: 256,
  maxStringBytes: 128 * 1024,
  wallTimeMs: 5_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  stackLimitBytes: 4 * 1024 * 1024,
  maxInterrupts: 100_000,
});

const MAX_NATIVE_WORKFLOW_LIMITS: NativeWorkflowLimits = Object.freeze({
  maxSourceBytes: 1024 * 1024,
  maxTransformedBytes: 2 * 1024 * 1024,
  maxSerializedIRBytes: 4 * 1024 * 1024,
  maxPlanNodes: 4_096,
  maxCodecCalls: 16_384,
  maxCodecBytes: 1024 * 1024,
  maxJsonDepth: 64,
  maxObjectKeys: 4_096,
  maxArrayItems: 4_096,
  maxStringBytes: 1024 * 1024,
  wallTimeMs: 60_000,
  memoryLimitBytes: 256 * 1024 * 1024,
  stackLimitBytes: 32 * 1024 * 1024,
  maxInterrupts: 1_000_000,
});

type QuickJSModule = Awaited<ReturnType<typeof newQuickJSWASMModule>>;
type QuickJSContext = ReturnType<QuickJSModule["newContext"]>;
type QuickJSRuntime = ReturnType<QuickJSModule["newRuntime"]>;

type NativeGraph = Readonly<{
  readonly nodes: readonly NativeWorkflowNodeIR[];
  readonly roots: readonly string[];
  readonly output: NativeWorkflowOutputIR;
  readonly conflicts: readonly string[];
}>;

type NativeWaitTarget = Readonly<{
  readonly key: string;
  readonly runId: string;
  readonly graph: NativeGraph;
  readonly output: NativeWorkflowOutputIR;
}>;

type NativeHandle = Readonly<
  | { readonly kind: "workflow"; readonly graph: NativeGraph }
  | { readonly kind: "run"; readonly graph: NativeGraph; readonly runId: string }
  | { readonly kind: "wait"; readonly targets: readonly NativeWaitTarget[] }
>;

type CodecRecord = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly decoder?: QuickJSHandle;
  readonly schema?: PortableSchemaIR;
}>;

type SymbolicOutput = Readonly<{ readonly token: string; readonly output: NativeWorkflowOutputIR }>;

/** Load and evaluate a TypeScript workflow only inside a bounded QuickJS context. */
export async function evaluateNativeWorkflowSource(
  input: Readonly<{
    readonly source: string;
    readonly limits?: NativeWorkflowLimitsInput;
  }>,
): Promise<NativeWorkflow> {
  const limits = mergeNativeWorkflowLimits(input.limits);
  const transformed = transformNativeWorkflowSource(
    input.source,
    limits.maxSourceBytes,
    limits.maxTransformedBytes,
  );
  const sourceDigest = await domainSeparatedSha256("holycodex-native-workflow-source", [
    canonicalJsonUtf8(input.source),
  ]);
  const transformedDigest = await domainSeparatedSha256("holycodex-native-workflow-transformed", [
    canonicalJsonUtf8(transformed),
  ]);
  const quickjsModule = await newQuickJSWASMModule();
  const session = new NativeSourceSession(quickjsModule, limits);
  try {
    const graph = session.evaluate(transformed);
    const codecs = session.codecDescriptors();
    const graphIdentity = {
      nodes: graph.nodes,
      roots: graph.roots,
      conflicts: graph.conflicts,
      terminals: graph.terminals,
    };
    const graphId = stableHash(canonicalJson(graphIdentity));
    const identityDigest = await nativeWorkflowIdentityDigest({
      abiVersion: NATIVE_WORKFLOW_ABI_VERSION,
      executionMode: "native",
      sourceDigest,
      transformedDigest,
      graph: graphIdentity,
      codecs,
      capacityInputs: capacityInputsForGraph(graph),
      compileOptions: {},
    });
    const ir = freezeWorkflowPlanIR({
      version: 1,
      abiVersion: NATIVE_WORKFLOW_ABI_VERSION,
      executionMode: "native",
      sourceDigest,
      transformedDigest,
      identityDigest,
      graphId,
      capacityInputs: capacityInputsForGraph(graph),
      graph: {
        nodes: graph.nodes,
        roots: graph.roots,
        conflicts: graph.conflicts,
        terminals: graph.terminals,
      },
      codecs,
    });
    const serializedBytes = new TextEncoder().encode(canonicalJson(ir)).byteLength;
    if (serializedBytes > limits.maxSerializedIRBytes) {
      throw new WorkflowRuntimeError("resource_limit", "The native workflow IR is too large.");
    }
    const codecMap = session.codecProxies();
    return Object.freeze({ ir, codecs: codecMap, dispose: () => session.dispose() });
  } catch (error) {
    session.dispose();
    throw error;
  }
}

/** Alias used by host integrations that treat native source loading as a boundary. */
export const loadNativeWorkflowSource = evaluateNativeWorkflowSource;

/** Validate and clamp native source, graph, codec, and QuickJS resource limits. */
export function mergeNativeWorkflowLimits(
  input: NativeWorkflowLimitsInput = {},
): NativeWorkflowLimits {
  const parsed = decodeUnknown(NativeWorkflowLimitsSchema, input);
  if (Either.isLeft(parsed)) {
    throw new WorkflowRuntimeError("invalid_input", "The native workflow limits are invalid.");
  }
  const merged = { ...DEFAULT_NATIVE_WORKFLOW_LIMITS } as {
    -readonly [Key in keyof NativeWorkflowLimits]: number;
  };
  for (const key of Object.keys(MAX_NATIVE_WORKFLOW_LIMITS) as Array<keyof NativeWorkflowLimits>) {
    const override = parsed.right[key];
    if (override !== undefined) merged[key] = override;
    const value = merged[key];
    if (value > MAX_NATIVE_WORKFLOW_LIMITS[key]) {
      throw new WorkflowRuntimeError(
        "invalid_input",
        "The native workflow limit exceeds its safe ceiling.",
        {
          field: key,
        },
      );
    }
  }
  return Object.freeze(merged);
}

class NativeSourceSession {
  private readonly codecs = new Map<string, CodecRecord>();
  private readonly handles = new Map<string, NativeHandle>();
  private readonly symbolics = new Map<string, SymbolicOutput>();
  private readonly limits: NativeWorkflowLimits;
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private serializeFunction: QuickJSHandle | undefined;
  private symbolicFunction: QuickJSHandle | undefined;
  private nextHandle = 0;
  private nextCodec = 0;
  private nextSymbolic = 0;
  private deadline = 0;
  private interrupts = 0;
  private codecCalls = 0;
  private callbackFailure: WorkflowRuntimeError | undefined;
  private disposed = false;

  constructor(quickjsModule: QuickJSModule, limits: NativeWorkflowLimits) {
    this.limits = limits;
    this.runtime = quickjsModule.newRuntime();
    this.runtime.setMemoryLimit(limits.memoryLimitBytes);
    this.runtime.setMaxStackSize(limits.stackLimitBytes);
    this.beginBudget();
    this.context = this.runtime.newContext();
  }

  evaluate(
    transformed: string,
  ): NativeGraph & { readonly terminals: readonly NativeWorkflowTerminalIR[] } {
    const step = this.context.newFunction("__hcStep", (...args) =>
      this.callback(() => this.step(args)),
    );
    const queue = this.context.newFunction("__hcQueue", (...args) =>
      this.callback(() => this.queue(args)),
    );
    const start = this.context.newFunction("__hcStart", (...args) =>
      this.callback(() => this.start(args)),
    );
    const wait = this.context.newFunction("__hcWait", (...args) =>
      this.callback(() => this.wait(args)),
    );
    const createCodec = this.context.newFunction("__hcCreateCodec", (...args) =>
      this.callback(() => this.createCodec(args)),
    );
    const schema = this.context.evalCode(`
      (() => {
        const make = value => Object.freeze({ __holycodexSchema: Object.freeze(value) });
        const struct = fields => {
          const result = Object.create(null);
          for (const key of Object.keys(fields)) {
            const schema = fields[key]?.__holycodexSchema;
            if (!schema) throw new Error("The workflow struct field schema is invalid.");
            result[key] = schema;
          }
          return make({ kind: "struct", fields: result });
        };
        return Object.freeze({
          String: make({ kind: "string" }),
          Number: make({ kind: "number" }),
          Boolean: make({ kind: "boolean" }),
          Unknown: make({ kind: "unknown" }),
          Literal: value => {
            if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
              throw new Error("The workflow literal schema is invalid.");
            }
            return make({ kind: "literal", value });
          },
          Array: element => {
            if (!element?.__holycodexSchema) throw new Error("The workflow array schema is invalid.");
            return make({ kind: "array", element: element.__holycodexSchema });
          },
          Struct: struct
        });
      })()
    `);
    if (schema.error) {
      schema.error.dispose();
      throw new WorkflowRuntimeError(
        "evaluation_failed",
        "The native schema facade could not be prepared.",
      );
    }
    const bootstrap = this.context.evalCode(`
      (() => {
        const symbolicKey = Symbol("HolyCodex callback output");
        const symbolic = token => {
          const value = Object.create(null);
          Object.defineProperty(value, symbolicKey, {
            configurable: false,
            enumerable: false,
            value: token,
            writable: false
          });
          return Object.freeze(value);
        };
        const serialize = (value, seen = []) => {
          const symbolicToken = value === null || (typeof value !== "object" && typeof value !== "function")
            ? undefined
            : Object.getOwnPropertyDescriptor(value, symbolicKey)?.value;
          if (symbolicToken !== undefined) return { __hcOutputRef: symbolicToken };
          if (value === undefined) return { __hcUndefined: true };
          if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
            if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Workflow data must be finite JSON.");
            return value;
          }
          if (typeof value === "function") throw new Error("Workflow data must be inert.");
          if (typeof value !== "object" || seen.includes(value)) throw new Error("Workflow data must be acyclic JSON.");
          const prototype = Object.getPrototypeOf(value);
          if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
            throw new Error("Workflow data must be plain JSON.");
          }
          seen.push(value);
          try {
            if (Array.isArray(value)) return value.map(item => serialize(item, seen));
            const result = {};
            for (const key of Object.keys(value)) result[key] = serialize(value[key], seen);
            return result;
          } finally {
            seen.pop();
          }
        };
        return {
          serialize,
          symbolic
        };
      })();
    `);
    if (bootstrap.error) {
      bootstrap.error.dispose();
      throw new WorkflowRuntimeError(
        "evaluation_failed",
        "The native workflow context could not be prepared.",
      );
    }
    const bootstrapValue = bootstrap.value;
    const serialize = this.context.getProp(bootstrapValue, "serialize");
    const symbolic = this.context.getProp(bootstrapValue, "symbolic");
    bootstrapValue.dispose();
    this.serializeFunction = serialize;
    this.symbolicFunction = symbolic;
    const workflow = this.context.newObject();
    this.context.setProp(workflow, "step", step);
    this.context.setProp(workflow, "queue", queue);
    this.context.setProp(workflow, "start", start);
    this.context.setProp(workflow, "wait", wait);
    const frozenWorkflow = this.freeze(workflow);
    this.disposeHandle(workflow);
    this.context.setProp(this.context.global, "workflow", frozenWorkflow);
    this.context.setProp(this.context.global, "createCodec", createCodec);
    this.context.setProp(this.context.global, "Schema", schema.value);
    const result = this.context.evalCode(transformed);
    this.context.setProp(this.context.global, "workflow", this.context.undefined);
    this.context.setProp(this.context.global, "createCodec", this.context.undefined);
    this.context.setProp(this.context.global, "Schema", this.context.undefined);
    this.disposeHandle(frozenWorkflow);
    this.disposeHandle(step);
    this.disposeHandle(queue);
    this.disposeHandle(start);
    this.disposeHandle(wait);
    this.disposeHandle(createCodec);
    schema.value.dispose();
    if (result.error) {
      result.error.dispose();
      const callbackFailure = this.callbackFailure;
      this.callbackFailure = undefined;
      if (callbackFailure) throw callbackFailure;
      throw this.evaluationFailure();
    }
    const callbackFailure = this.callbackFailure;
    this.callbackFailure = undefined;
    if (callbackFailure) throw callbackFailure;
    const dumped = this.context.dump(result.value);
    result.value.dispose();
    let finalHandle: NativeHandle;
    try {
      finalHandle = this.readHandle(dumped);
    } catch {
      throw new WorkflowRuntimeError(
        "source_rejected",
        "The native workflow default export must be workflow.wait(...).",
      );
    }
    if (finalHandle.kind !== "wait") {
      throw new WorkflowRuntimeError(
        "source_rejected",
        "The native workflow default export must be workflow.wait(...).",
      );
    }
    if (this.handles.size > this.limits.maxPlanNodes * 4) {
      throw new WorkflowRuntimeError(
        "resource_limit",
        "The native workflow graph metadata is too large.",
      );
    }
    const targets = finalHandle.targets;
    const nodes = mergeTargets(targets).nodes;
    if (nodes.length > this.limits.maxPlanNodes) {
      throw new WorkflowRuntimeError(
        "resource_limit",
        "The native workflow graph exceeds its node limit.",
      );
    }
    return {
      nodes,
      roots: uniqueStrings(targets.flatMap((target) => target.graph.roots)),
      output:
        targets.length === 1
          ? (targets[0]?.output ?? { kind: "join", targets: [] })
          : joinOutputs(targets),
      conflicts: mergeTargets(targets).conflicts,
      terminals: targets.map((target) => ({
        key: target.key,
        runId: target.runId,
        output: target.output,
      })),
    };
  }

  codecDescriptors(): readonly NativeWorkflowCodecIR[] {
    return Object.freeze(
      [...this.codecs.values()].map(({ id, name, schema }) =>
        Object.freeze({ id, name, ...(schema === undefined ? {} : { schema }) }),
      ),
    );
  }

  codecProxies(): ReadonlyMap<string, ValueCodec<JsonValue>> {
    const result = new Map<string, ValueCodec<JsonValue>>();
    for (const record of this.codecs.values()) {
      result.set(
        record.id,
        Object.freeze({
          name: record.name,
          decode: (value: unknown) =>
            record.schema === undefined
              ? this.decode(record, value)
              : decodePortableSchema(record.schema, value),
        }),
      );
    }
    return readonlyMap(result);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.serializeFunction?.dispose();
    this.symbolicFunction?.dispose();
    this.serializeFunction = undefined;
    this.symbolicFunction = undefined;
    for (const record of this.codecs.values()) record.decoder?.dispose();
    this.codecs.clear();
    this.runtime.removeInterruptHandler();
    try {
      this.context.dispose();
    } finally {
      this.runtime.dispose();
    }
  }

  private step(args: readonly QuickJSHandle[]): QuickJSHandle {
    if (args.length !== 1) throw new Error("workflow.step expects one definition.");
    const definition = this.serializeHandle(args[0]);
    if (!isRecord(definition) || !isRecord(definition["assignment"])) {
      throw new Error("The workflow step definition is invalid.");
    }
    const assignment = this.assignment(definition["assignment"]);
    const node: NativeWorkflowNodeIR = {
      id: readString(definition["id"], "workflow step id"),
      name: readString(definition["id"], "workflow step name"),
      input: { kind: "root" },
      dependencies: Object.freeze([]),
      assignment,
    };
    const graph: NativeGraph = {
      nodes: Object.freeze([node]),
      roots: Object.freeze([node.id]),
      output: Object.freeze({ kind: "single", nodeId: node.id, codecId: assignment.outputCodecId }),
      conflicts: Object.freeze([]),
    };
    return this.handle({ kind: "workflow", graph });
  }

  private queue(args: readonly QuickJSHandle[]): QuickJSHandle {
    if (args.length < 1) throw new Error("workflow.queue requires a first workflow.");
    const first = this.readHandle(this.serializeHandle(args[0]));
    if (first.kind !== "workflow")
      throw new Error("workflow.queue requires a workflow first stage.");
    let graph = first.graph;
    for (let index = 1; index < args.length; index += 1) {
      const stageHandle = args[index];
      if (!stageHandle) throw new Error("The workflow queue stage is missing.");
      const stage =
        String(this.context.typeof(stageHandle)) === "function"
          ? this.invokeQueueCallback(stageHandle, graph.output)
          : this.readHandle(this.serializeHandle(stageHandle));
      const next = this.toStageGraph(stage);
      graph = connectGraphs(graph, next);
    }
    return this.handle({ kind: "workflow", graph });
  }

  private start(args: readonly QuickJSHandle[]): QuickJSHandle {
    if (args.length !== 1) throw new Error("workflow.start expects one workflow.");
    const value = this.readHandle(this.serializeHandle(args[0]));
    if (value.kind !== "workflow") throw new Error("workflow.start expects a workflow.");
    const runId = `run-${stableHash(canonicalJson(value.graph))}`;
    return this.handle({ kind: "run", graph: value.graph, runId });
  }

  private wait(args: readonly QuickJSHandle[]): QuickJSHandle {
    if (args.length !== 1) throw new Error("workflow.wait expects one workflow value.");
    const value = this.serializeHandle(args[0]);
    const targets: NativeWaitTarget[] = [];
    if (isRecord(value) && !this.isHandleDescriptor(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const handle = this.readHandle(entry);
        const target = this.target(handle, key);
        targets.push(target);
      }
    } else {
      const handle = this.readHandle(value);
      targets.push(this.target(handle, ""));
    }
    if (targets.length === 0) throw new Error("A native workflow wait requires a target.");
    return this.handle({ kind: "wait", targets: Object.freeze(targets) });
  }

  private createCodec(args: readonly QuickJSHandle[]): QuickJSHandle {
    if (args.length !== 2) throw new Error("createCodec expects a name and decoder.");
    const name = this.context.getString(args[0] ?? this.context.undefined);
    if (name.length === 0 || name.length > 256)
      throw new Error("A workflow codec name is invalid.");
    const id = `codec-${(this.nextCodec += 1)}`;
    const decoderValue = this.context.dump(args[1] ?? this.context.undefined);
    if (isPortableSchemaValue(decoderValue)) {
      if (!isPortableSchemaIR(decoderValue.__holycodexSchema)) {
        throw new Error("The workflow schema facade value is invalid.");
      }
      this.codecs.set(id, { id, name, schema: decoderValue.__holycodexSchema });
    } else {
      if (String(this.context.typeof(args[1] ?? this.context.undefined)) !== "function") {
        throw new Error("A workflow codec decoder must be a function.");
      }
      const decoder = args[1]?.dup();
      if (!decoder) throw new Error("The workflow codec decoder is unavailable.");
      this.codecs.set(id, { id, name, decoder });
    }
    return this.jsonHandle({ __hcCodecId: id, name });
  }

  private assignment(value: Readonly<Record<string, unknown>>): NativeWorkflowAssignmentIR {
    const input = this.codec(value["input"], "input");
    const output = this.codec(value["output"], "output");
    const payloadValue = value["payload"];
    const hasPayload = payloadValue !== undefined && !isUndefinedMarker(payloadValue);
    const payload = hasPayload ? this.replaceOutputRefs(payloadValue) : null;
    if (!isJsonValue(payload))
      throw new Error("The workflow assignment payload is not inert JSON.");
    const metadata = readMetadata(value["metadata"]);
    const route = value["route"];
    if (route !== undefined && typeof route !== "string")
      throw new Error("The workflow assignment route is invalid.");
    return Object.freeze({
      hasPayload,
      payload,
      inputCodecId: input.id,
      outputCodecId: output.id,
      metadata,
      ...(route === undefined ? {} : { route }),
    });
  }

  private codec(value: unknown, label: string): NativeWorkflowCodecIR {
    if (
      !isRecord(value) ||
      typeof value["__hcCodecId"] !== "string" ||
      typeof value["name"] !== "string"
    ) {
      throw new Error(`The workflow ${label} codec is invalid.`);
    }
    const codec = this.codecs.get(value["__hcCodecId"]);
    if (!codec || codec.name !== value["name"])
      throw new Error(`The workflow ${label} codec is unknown.`);
    return { id: codec.id, name: codec.name };
  }

  private invokeQueueCallback(
    callback: QuickJSHandle,
    output: NativeWorkflowOutputIR,
  ): NativeHandle {
    const token = `output-${(this.nextSymbolic += 1)}`;
    this.symbolics.set(token, { token, output });
    const symbolic = this.symbolicHandle(token);
    const result = this.context.callFunction(callback, this.context.undefined, symbolic);
    symbolic.dispose();
    if (result.error) {
      result.error.dispose();
      throw new Error("The workflow queue callback failed.");
    }
    const value = this.readHandle(this.serializeHandle(result.value));
    result.value.dispose();
    return value;
  }

  private toStageGraph(value: NativeHandle): NativeGraph {
    if (value.kind === "workflow") return value.graph;
    if (value.kind !== "wait")
      throw new Error("A workflow queue stage must return a workflow or wait.");
    const merged = mergeTargets(value.targets);
    return Object.freeze({
      nodes: merged.nodes,
      roots: merged.roots,
      output:
        value.targets.length === 1 && value.targets[0]?.key === ""
          ? (value.targets[0]?.output ?? merged.output)
          : joinOutputs(value.targets),
      conflicts: merged.conflicts,
    });
  }

  private target(value: NativeHandle, key: string): NativeWaitTarget {
    if (value.kind === "wait") throw new Error("A workflow wait cannot contain another wait.");
    const run =
      value.kind === "run"
        ? value
        : { ...value, runId: `run-${stableHash(canonicalJson(value.graph))}` };
    return Object.freeze({ key, runId: run.runId, graph: run.graph, output: run.graph.output });
  }

  private handle(value: NativeHandle): QuickJSHandle {
    const id = `handle-${(this.nextHandle += 1)}`;
    this.handles.set(id, value);
    return this.jsonHandle({ __hcWorkflowId: id });
  }

  private readHandle(value: unknown): NativeHandle {
    if (!isRecord(value) || typeof value["__hcWorkflowId"] !== "string") {
      throw new Error("The native workflow value is invalid.");
    }
    const handle = this.handles.get(value["__hcWorkflowId"]);
    if (!handle) throw new Error("The native workflow value is unknown.");
    return handle;
  }

  private isHandleDescriptor(value: Readonly<Record<string, unknown>>): boolean {
    return typeof value["__hcWorkflowId"] === "string";
  }

  private replaceOutputRefs(value: unknown, seen = new Set<object>()): JsonValue {
    if (isRecord(value) && typeof value["__hcOutputRef"] === "string") {
      if (Object.keys(value).length !== 1) {
        throw new Error("The workflow payload output reference marker is reserved.");
      }
      const symbolic = this.symbolics.get(value["__hcOutputRef"]);
      if (!symbolic) throw new Error("The workflow callback output reference is invalid.");
      return { [NATIVE_OUTPUT_REFERENCE_KEY]: symbolic.output };
    }
    if (!isJsonValue(value)) throw new Error("The workflow payload is not inert JSON.");
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("The workflow payload is cyclic.");
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => this.replaceOutputRefs(entry, seen));
      const result: Record<string, JsonValue> = {};
      for (const [key, entry] of Object.entries(value))
        result[key] = this.replaceOutputRefs(entry, seen);
      return result;
    } finally {
      seen.delete(value);
    }
  }

  private serializeHandle(value: QuickJSHandle | undefined): unknown {
    if (!value) throw new Error("The native workflow value is unavailable.");
    const serialize = this.serializeFunction;
    if (!serialize) throw new Error("The native workflow serializer is unavailable.");
    const result = this.context.callFunction(serialize, this.context.undefined, value);
    if (result.error) {
      result.error.dispose();
      throw new Error("The native workflow value is not inert JSON.");
    }
    const dumped = this.context.dump(result.value);
    result.value.dispose();
    assertBoundedJson(dumped, this.limits);
    return dumped;
  }

  private symbolicHandle(token: string): QuickJSHandle {
    const symbolic = this.symbolicFunction;
    if (!symbolic) throw new Error("The native workflow symbolic value is unavailable.");
    const tokenHandle = this.jsonHandle(token);
    const result = this.context.callFunction(symbolic, this.context.undefined, tokenHandle);
    tokenHandle.dispose();
    if (result.error) {
      result.error.dispose();
      throw new Error("The native workflow symbolic value could not be created.");
    }
    return result.value;
  }

  private freeze(value: QuickJSHandle): QuickJSHandle {
    const result = this.context.evalCode("Object.freeze");
    if (result.error) {
      result.error.dispose();
      throw new Error("The native workflow context could not be prepared.");
    }
    const frozen = this.context.callFunction(result.value, this.context.undefined, value);
    result.value.dispose();
    if (frozen.error) {
      frozen.error.dispose();
      throw new Error("The native workflow DSL could not be frozen.");
    }
    return frozen.value;
  }

  private jsonHandle(value: JsonValue): QuickJSHandle {
    const result = this.context.evalCode(`JSON.parse(${JSON.stringify(canonicalJson(value))})`);
    if (result.error) {
      result.error.dispose();
      throw new Error("The native workflow JSON value is invalid.");
    }
    return result.value;
  }

  private beginBudget(): void {
    this.deadline = Date.now() + this.limits.wallTimeMs;
    this.interrupts = 0;
    this.runtime.setInterruptHandler(() => {
      this.interrupts += 1;
      return this.interrupts > this.limits.maxInterrupts || Date.now() >= this.deadline;
    });
  }

  private decode(record: CodecRecord, value: unknown): JsonValue {
    if (record.decoder === undefined) {
      throw new WorkflowRuntimeError("invalid_result", "The native codec decoder is unavailable.");
    }
    if (this.disposed)
      throw new WorkflowRuntimeError(
        "evaluation_failed",
        "The native workflow sandbox is disposed.",
      );
    if (!isJsonValue(value))
      throw new WorkflowRuntimeError("invalid_result", "The codec input is not JSON.");
    const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (bytes > this.limits.maxCodecBytes)
      throw new WorkflowRuntimeError("resource_limit", "The codec input is too large.");
    this.codecCalls += 1;
    if (this.codecCalls > this.limits.maxCodecCalls)
      throw new WorkflowRuntimeError("resource_limit", "The native codec call limit was exceeded.");
    this.beginBudget();
    const input = this.jsonHandle(value);
    const result = this.context.callFunction(record.decoder, this.context.undefined, input);
    input.dispose();
    if (result.error) {
      result.error.dispose();
      throw new WorkflowRuntimeError(
        Date.now() >= this.deadline || this.interrupts > this.limits.maxInterrupts
          ? "timed_out"
          : "invalid_result",
        Date.now() >= this.deadline || this.interrupts > this.limits.maxInterrupts
          ? "The native codec decoder timed out."
          : "The native codec decoder failed.",
      );
    }
    if (String(this.context.typeof(result.value)) === "object") {
      const then = this.context.getProp(result.value, "then");
      const isThenable = String(this.context.typeof(then)) === "function";
      then.dispose();
      if (isThenable) {
        result.value.dispose();
        throw new WorkflowRuntimeError(
          "invalid_result",
          "Native codec decoders must be synchronous.",
        );
      }
    }
    const dumped = this.context.dump(result.value);
    result.value.dispose();
    if (!isJsonValue(dumped))
      throw new WorkflowRuntimeError("invalid_result", "The native codec output is not JSON.");
    assertBoundedJson(dumped, this.limits);
    if (new TextEncoder().encode(canonicalJson(dumped)).byteLength > this.limits.maxCodecBytes) {
      throw new WorkflowRuntimeError("resource_limit", "The codec output is too large.");
    }
    return dumped;
  }

  private evaluationFailure(): WorkflowRuntimeError {
    if (Date.now() >= this.deadline || this.interrupts > this.limits.maxInterrupts) {
      return new WorkflowRuntimeError("timed_out", "The native workflow evaluation timed out.");
    }
    return new WorkflowRuntimeError("evaluation_failed", "The native workflow evaluation failed.");
  }

  private disposeHandle(value: QuickJSHandle | undefined): void {
    value?.dispose();
  }

  private callback(action: () => QuickJSHandle): QuickJSHandle {
    try {
      return action();
    } catch (error) {
      if (error instanceof WorkflowRuntimeError) this.callbackFailure = error;
      throw error;
    }
  }
}

function isPortableSchemaValue(
  value: unknown,
): value is Readonly<{ readonly __holycodexSchema: PortableSchemaIR }> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "__holycodexSchema" in value &&
    typeof value.__holycodexSchema === "object" &&
    value.__holycodexSchema !== null
  );
}

function isPortableSchemaIR(value: unknown): value is PortableSchemaIR {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  const kind = value["kind"];
  if (kind === "string" || kind === "number" || kind === "boolean" || kind === "unknown")
    return true;
  if (kind === "literal") {
    const literal = value["value"];
    return (
      literal === null ||
      typeof literal === "string" ||
      typeof literal === "boolean" ||
      (typeof literal === "number" && Number.isFinite(literal))
    );
  }
  if (kind === "array") return isPortableSchemaIR(value["element"]);
  if (
    kind === "struct" &&
    typeof value["fields"] === "object" &&
    value["fields"] !== null &&
    !Array.isArray(value["fields"])
  ) {
    return Object.values(value["fields"]).every(isPortableSchemaIR);
  }
  return false;
}

function readMetadata(value: unknown): AssignmentMetadata {
  if (value === undefined) return {};
  if (!isRecord(value) || !isJsonValue(value))
    throw new Error("The workflow assignment metadata is invalid.");
  const id = readOptionalString(value["id"], "metadata.id");
  const capabilities = readOptionalStringArray(value["capabilities"], "metadata.capabilities");
  const dependencies = readOptionalStringArray(value["dependencies"], "metadata.dependencies");
  const retries = readOptionalInteger(value["retries"], "metadata.retries");
  const attempt = readOptionalInteger(value["attempt"], "metadata.attempt");
  const timeoutMs = readOptionalInteger(value["timeoutMs"], "metadata.timeoutMs");
  const writes = readOptionalStringArray(value["writes"], "metadata.writes");
  const when = readCondition(value["when"]);
  const stopWhen = readPredicate(value["stopWhen"]);
  const repeatUntil = readRepeatUntil(value["repeatUntil"]);
  const metadata: AssignmentMetadata = {
    ...(id === undefined ? {} : { id }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(retries === undefined ? {} : { retries }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(writes === undefined ? {} : { writes }),
    ...(when === undefined ? {} : { when }),
    ...(stopWhen === undefined ? {} : { stopWhen }),
    ...(repeatUntil === undefined ? {} : { repeatUntil }),
  };
  const allowed = new Set([
    "id",
    "capabilities",
    "dependencies",
    "retries",
    "attempt",
    "timeoutMs",
    "writes",
    "when",
    "stopWhen",
    "repeatUntil",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("The workflow assignment metadata contains an unsupported field.");
  }
  return Object.freeze(metadata);
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`The ${field} is invalid.`);
  return value;
}

function readOptionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`The ${field} is invalid.`);
  }
  return Object.freeze(value.map((entry) => readString(entry, field)));
}

function readOptionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`The ${field} is invalid.`);
  return value;
}

function readCondition(value: unknown): WorkflowCondition | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value["source"] !== "string" ||
    !isStringArray(value["path"]) ||
    !isJsonValue(value["equals"])
  ) {
    throw new Error("The workflow condition is invalid.");
  }
  return { source: value["source"], path: value["path"], equals: value["equals"] };
}

function readPredicate(value: unknown): WorkflowPredicate | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isStringArray(value["path"]) || !isJsonValue(value["equals"])) {
    throw new Error("The workflow predicate is invalid.");
  }
  return { path: value["path"], equals: value["equals"] };
}

function readRepeatUntil(value: unknown): WorkflowRepeatUntil | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !isStringArray(value["path"]) ||
    !isJsonValue(value["equals"]) ||
    typeof value["maxIterations"] !== "number" ||
    !Number.isInteger(value["maxIterations"])
  ) {
    throw new Error("The workflow repeat policy is invalid.");
  }
  return { path: value["path"], equals: value["equals"], maxIterations: value["maxIterations"] };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function mergeTargets(targets: readonly NativeWaitTarget[]): NativeGraph {
  const nodes: NativeWorkflowNodeIR[] = [];
  const roots: string[] = [];
  const conflicts: string[] = [];
  const byId = new Map<string, NativeWorkflowNodeIR>();
  for (const target of targets) {
    roots.push(...target.graph.roots);
    for (const node of target.graph.nodes) {
      const existing = byId.get(node.id);
      if (existing === undefined) {
        byId.set(node.id, node);
        nodes.push(node);
      } else if (canonicalJson(existing) !== canonicalJson(node)) {
        conflicts.push(node.id);
      }
    }
    conflicts.push(...target.graph.conflicts);
  }
  const output =
    targets.length === 1
      ? (targets[0]?.output ?? { kind: "join", targets: [] })
      : joinOutputs(targets);
  return {
    nodes: Object.freeze(nodes),
    roots: Object.freeze(uniqueStrings(roots)),
    output,
    conflicts: Object.freeze(uniqueStrings(conflicts)),
  };
}

function connectGraphs(left: NativeGraph, right: NativeGraph): NativeGraph {
  const nodes = new Map(left.nodes.map((node) => [node.id, node] as const));
  const conflicts = [...left.conflicts, ...right.conflicts];
  for (const node of right.nodes) {
    const rebound =
      node.input.kind === "root"
        ? Object.freeze({
            ...node,
            input: inputFromOutput(left.output),
            dependencies: dependenciesForInput(inputFromOutput(left.output)),
          })
        : node;
    const existing = nodes.get(node.id);
    if (existing === undefined) nodes.set(node.id, rebound);
    else if (canonicalJson(existing) !== canonicalJson(rebound)) conflicts.push(node.id);
  }
  return Object.freeze({
    nodes: Object.freeze([...nodes.values()]),
    roots: left.roots,
    output: right.output,
    conflicts: Object.freeze(uniqueStrings(conflicts)),
  });
}

function inputFromOutput(output: NativeWorkflowOutputIR): NativeWorkflowInputIR {
  return output.kind === "single"
    ? { kind: "single", nodeId: output.nodeId }
    : { kind: "join", targets: output.targets };
}

function dependenciesForInput(input: NativeWorkflowInputIR): readonly string[] {
  if (input.kind === "root") return [];
  if (input.kind === "single") return [input.nodeId];
  return input.targets.flatMap(outputTargetNodeIds);
}

function outputTargetNodeIds(target: NativeWorkflowOutputTargetIR): readonly string[] {
  return target.source === undefined
    ? [target.nodeId]
    : target.source.kind === "single"
      ? [target.source.nodeId]
      : target.source.targets.flatMap(outputTargetNodeIds);
}

function joinOutputs(targets: readonly NativeWaitTarget[]): NativeWorkflowOutputIR {
  return {
    kind: "join",
    targets: Object.freeze(targets.map((target) => outputTargetsForWaitTarget(target))),
  };
}

function outputTargetsForWaitTarget(target: NativeWaitTarget): NativeWorkflowOutputTargetIR {
  if (target.output.kind === "single") {
    return { key: target.key, nodeId: target.output.nodeId, codecId: target.output.codecId };
  }
  const first = target.output.targets[0];
  if (!first) throw new Error("The native workflow join has no output target.");
  return { key: target.key, nodeId: first.nodeId, codecId: first.codecId, source: target.output };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function readonlyMap<K, V>(input: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map(input);
  return Object.freeze({
    get: map.get.bind(map),
    has: map.has.bind(map),
    keys: map.keys.bind(map),
    values: map.values.bind(map),
    entries: map.entries.bind(map),
    forEach: map.forEach.bind(map),
    get size(): number {
      return map.size;
    },
    [Symbol.iterator]: map[Symbol.iterator].bind(map),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBoundedJson(
  value: unknown,
  limits: NativeWorkflowLimits,
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > limits.maxJsonDepth) {
    throw new WorkflowRuntimeError("resource_limit", "The native workflow JSON is too deep.");
  }
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > limits.maxStringBytes) {
      throw new WorkflowRuntimeError("resource_limit", "The native workflow string is too large.");
    }
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (!isRecord(value) && !Array.isArray(value)) {
    throw new WorkflowRuntimeError("invalid_result", "The native workflow value is not JSON.");
  }
  if (seen.has(value)) {
    throw new WorkflowRuntimeError("invalid_result", "The native workflow JSON is cyclic.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        throw new WorkflowRuntimeError("resource_limit", "The native workflow array is too large.");
      }
      for (const entry of value) assertBoundedJson(entry, limits, depth + 1, seen);
      return;
    }
    const entries = Object.entries(value);
    if (entries.length > limits.maxObjectKeys) {
      throw new WorkflowRuntimeError("resource_limit", "The native workflow object is too large.");
    }
    for (const [, entry] of entries) assertBoundedJson(entry, limits, depth + 1, seen);
  } finally {
    seen.delete(value);
  }
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`The ${field} is invalid.`);
  return value;
}

function readUndefined(value: unknown): boolean {
  return isRecord(value) && value["__hcUndefined"] === true;
}

function isUndefinedMarker(value: unknown): boolean {
  return readUndefined(value);
}

function stableHash(source: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `graph-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function capacityInputsForGraph(
  graph: Readonly<{
    readonly nodes: readonly NativeWorkflowNodeIR[];
    readonly terminals: readonly NativeWorkflowTerminalIR[];
    readonly roots: readonly string[];
  }>,
): NativeWorkflowCapacityInputsIR {
  return Object.freeze({
    nodeCount: graph.nodes.length,
    rootCount: graph.roots.length,
    terminalCount: graph.terminals.length,
    maxRetries: graph.nodes.reduce(
      (maximum, node) => Math.max(maximum, node.assignment.metadata.retries ?? 0),
      0,
    ),
  });
}

function decodeUnknown<A>(schema: Schema.Schema<A>, value: unknown): Either.Either<A, unknown> {
  return Schema.decodeUnknownEither(schema)(value);
}
