// SPDX-License-Identifier: Apache-2.0

import { CLI_SCHEMA_VERSION, canonicalJson, decodeUnknown, type JsonValue } from "@holycodex/core";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  readWaitDecoder,
  readWaitTargets,
  makeSymbolicValue,
  type Assignment,
  type AssignmentMetadata,
  type Wait,
  type WorkflowCondition,
  type WorkflowInputSource,
  type WorkflowNode,
  type WorkflowOutputTarget,
  type WorkflowPredicate,
  type WorkflowRepeatUntil,
  type WorkflowOutput,
} from "./dsl.ts";
import { isWorkflowFailure, workflowFailure, type WorkflowFailure } from "./errors.ts";
import type { ValueCodec } from "./schema.ts";
import {
  NATIVE_OUTPUT_REFERENCE_KEY,
  freezeWorkflowPlanIR,
  nativePlanJson,
  nativeWorkflowIdentityDigest,
  isNativeWorkflowOutputIR,
  validateWorkflowPlanIR,
  type NativeWorkflow,
  type NativeWorkflowInputIR,
  type NativeWorkflowNodeIR,
  type NativeWorkflowOutputIR,
  type NativeWorkflowOutputTargetIR,
  type NativeWorkflowTerminalIR,
  type WorkflowPlanIR,
} from "./native-ir.ts";

export type PlanCapacity = Readonly<{
  readonly planConcurrency: number;
  readonly sessionConcurrency: number;
  readonly codexConcurrency: number;
  readonly maxRetries: number;
  readonly maxCalls?: number;
  readonly costMax?: number;
}>;

export type CompileOptions = Readonly<{
  readonly capabilities?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly maxNodes?: number;
  readonly capacity?: Partial<PlanCapacity>;
}>;

const IdentifierSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u));
const NonNegativeIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));
const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));
const JsonValueSchema = Schema.declare((value: unknown): value is JsonValue => isJsonValue(value));
const PathSchema = Schema.Array(Schema.String);
const WriteScopeSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096));
const ConditionSchema = Schema.Struct({
  source: IdentifierSchema,
  path: PathSchema,
  equals: JsonValueSchema,
});
const PredicateSchema = Schema.Struct({ path: PathSchema, equals: JsonValueSchema });
const RepeatUntilSchema = Schema.Struct({
  path: PathSchema,
  equals: JsonValueSchema,
});
const AssignmentMetadataSchema = Schema.Struct({
  id: Schema.optional(IdentifierSchema),
  capabilities: Schema.optional(Schema.Array(IdentifierSchema)),
  dependencies: Schema.optional(Schema.Array(IdentifierSchema)),
  retries: Schema.optional(NonNegativeIntegerSchema),
  attempt: Schema.optional(NonNegativeIntegerSchema),
  writes: Schema.optional(Schema.Array(WriteScopeSchema)),
  when: Schema.optional(ConditionSchema),
  stopWhen: Schema.optional(PredicateSchema),
  repeatUntil: Schema.optional(RepeatUntilSchema),
});
const CapacitySchema = Schema.Struct({
  planConcurrency: Schema.optional(PositiveIntegerSchema),
  sessionConcurrency: Schema.optional(PositiveIntegerSchema),
  codexConcurrency: Schema.optional(PositiveIntegerSchema),
  maxRetries: Schema.optional(NonNegativeIntegerSchema),
  maxCalls: Schema.optional(NonNegativeIntegerSchema),
  costMax: Schema.optional(
    Schema.Number.pipe(Schema.filter(Number.isFinite), Schema.greaterThanOrEqualTo(0)),
  ),
});
export const CompileOptionsSchema = Schema.Struct({
  capabilities: Schema.optional(Schema.Array(IdentifierSchema)),
  dependencies: Schema.optional(Schema.Array(IdentifierSchema)),
  maxNodes: Schema.optional(PositiveIntegerSchema),
  capacity: Schema.optional(CapacitySchema),
});

export type CompiledNode = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly input: WorkflowInputSource;
  readonly dependencies: readonly string[];
  readonly assignment: Assignment<JsonValue, JsonValue>;
  readonly inputCodec: ValueCodec<JsonValue>;
  readonly outputCodec: ValueCodec<JsonValue>;
  readonly metadata: CompiledNodeMetadata;
}>;

export type CompiledNodeMetadata = Readonly<{
  readonly capabilities: readonly string[];
  readonly dependencies: readonly string[];
  readonly retries: number;
  readonly writes: readonly string[];
  readonly when?: WorkflowCondition;
  readonly stopWhen?: WorkflowPredicate;
  readonly repeatUntil?: WorkflowRepeatUntil;
}>;

export type PlanTerminal = Readonly<{
  readonly key: string;
  readonly nodeId: string;
  readonly runId: string;
  readonly targets: readonly WorkflowOutputTarget[];
}>;

export class ExecutionPlan<T> {
  declare readonly result: T;
  readonly version = CLI_SCHEMA_VERSION;
  readonly graphId: string;
  readonly nodes: readonly CompiledNode[];
  readonly layers: readonly (readonly string[])[];
  readonly roots: readonly string[];
  readonly terminals: readonly PlanTerminal[];
  readonly capacity: PlanCapacity;
  readonly identityDigest: string;
  readonly decodeResult: (value: unknown) => T;

  protected constructor(
    input: Readonly<{
      readonly nodes: readonly CompiledNode[];
      readonly layers: readonly (readonly string[])[];
      readonly roots: readonly string[];
      readonly terminals: readonly PlanTerminal[];
      readonly capacity: PlanCapacity;
      readonly graphId: string;
      readonly identityDigest: string;
      readonly decodeResult: (value: unknown) => T;
    }>,
  ) {
    this.nodes = Object.freeze([...input.nodes]);
    this.layers = Object.freeze(input.layers.map((layer) => Object.freeze([...layer])));
    this.roots = Object.freeze([...input.roots]);
    this.terminals = Object.freeze(
      input.terminals.map((terminal) =>
        Object.freeze({
          ...terminal,
          targets: Object.freeze([...terminal.targets]),
        }),
      ),
    );
    this.capacity = Object.freeze({ ...input.capacity });
    this.graphId = input.graphId;
    this.identityDigest = input.identityDigest;
    this.decodeResult = input.decodeResult;
    Object.freeze(this);
  }
}

class ExecutionPlanHandle<T> extends ExecutionPlan<T> {
  constructor(
    input: Readonly<{
      readonly nodes: readonly CompiledNode[];
      readonly layers: readonly (readonly string[])[];
      readonly roots: readonly string[];
      readonly terminals: readonly PlanTerminal[];
      readonly capacity: PlanCapacity;
      readonly graphId: string;
      readonly identityDigest: string;
      readonly decodeResult: (value: unknown) => T;
    }>,
  ) {
    super(input);
  }
}

export function compileWorkflow<T extends JsonValue, I extends JsonValue = JsonValue>(
  terminal: Wait<I, T>,
  options: CompileOptions = {},
): Effect.Effect<ExecutionPlan<T>, WorkflowFailure> {
  return Effect.try({
    try: () => compileWorkflowUnsafe(terminal, options),
    catch: (error: unknown) => toCompilationFailure(error),
  });
}

export function compileWorkflowUnsafe<T extends JsonValue, I extends JsonValue = JsonValue>(
  terminal: Wait<I, T>,
  options: CompileOptions = {},
): ExecutionPlan<T> {
  const policy = parseCompileOptions(options);
  const targets = readWaitTargets(terminal);
  if (targets.length === 0) {
    throw workflowFailure("compilation", "A workflow must close at a waited terminal.");
  }

  const allNodes = new Map<string, WorkflowNode>();
  const conflicts = new Set<string>();
  const roots: string[] = [];
  const terminals: PlanTerminal[] = [];
  const terminalKeys = new Set<string>();
  for (const target of targets) {
    if (
      (target.key.length > 0 && !isValidIdentifier(target.key)) ||
      terminalKeys.has(target.key) ||
      (target.key === "" && targets.length !== 1)
    ) {
      throw workflowFailure("compilation", "The workflow wait shape is invalid.");
    }
    if (target.output.kind === "join") {
      validateOutputTargets(target.output.targets);
    }
    terminalKeys.add(target.key);
    roots.push(...target.graph.roots);
    terminals.push(toPlanTerminal(target.key, target.runId, target.output));
    for (const [id, node] of target.graph.nodes) {
      const existing = allNodes.get(id);
      if (existing === undefined) {
        allNodes.set(id, node);
      } else if (existing.assignment !== node.assignment) {
        conflicts.add(id);
      }
    }
    for (const conflict of target.graph.conflicts) {
      conflicts.add(conflict);
    }
  }

  if (conflicts.size > 0) {
    throw workflowFailure("compilation", "The workflow graph contains conflicting declarations.");
  }
  if (allNodes.size === 0 || allNodes.size > policy.maxNodes) {
    throw workflowFailure("compilation", "The workflow graph exceeds its admitted node capacity.");
  }

  const nodes = [...allNodes.values()].map((node) => compileNode(node, policy));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  validateGraph(nodes, nodeById, roots, terminals);
  const layers = topologicalLayers(nodes, nodeById);
  validateWriterOwnership(layers, nodeById);
  const uniqueRoots = uniqueStrings(roots);
  const uniqueTerminals = uniqueTerminalsByShape(terminals);

  return new ExecutionPlanHandle({
    nodes,
    layers,
    roots: uniqueRoots,
    terminals: uniqueTerminals,
    capacity: policy.capacity,
    graphId: stablePlanId(nodes, uniqueTerminals),
    identityDigest: stablePlanId(nodes, uniqueTerminals),
    decodeResult: readWaitDecoder(terminal),
  });
}

/**
 * Hydrates and validates inert native IR into the existing Effect execution
 * plan. This is the sole compiler-owned entry for source-authored native IR.
 */
export function hydrateWorkflowPlanIR(
  native: NativeWorkflow,
  options: CompileOptions = {},
): Effect.Effect<ExecutionPlan<unknown>, WorkflowFailure> {
  return Effect.tryPromise({
    try: async () => await hydrateWorkflowPlanIRUnsafe(native, options),
    catch: (error: unknown) => toCompilationFailure(error),
  });
}

/** Alias retained for callers that describe hydration as native plan compilation. */
export const compileWorkflowPlanIR = hydrateWorkflowPlanIR;

async function hydrateWorkflowPlanIRUnsafe(
  native: NativeWorkflow,
  options: CompileOptions,
): Promise<ExecutionPlan<unknown>> {
  if (!validateWorkflowPlanIR(native.ir)) {
    throw workflowFailure("validation", "The native workflow plan IR is invalid.");
  }
  const ir = freezeWorkflowPlanIR(native.ir);
  const expectedIdentityDigest = await nativeWorkflowIdentityDigest({
    abiVersion: ir.abiVersion,
    executionMode: ir.executionMode,
    sourceDigest: ir.sourceDigest,
    transformedDigest: ir.transformedDigest,
    graph: ir.graph,
    codecs: ir.codecs,
    capacityInputs: ir.capacityInputs,
    compileOptions: {},
  });
  if (ir.identityDigest !== expectedIdentityDigest) {
    throw workflowFailure("validation", "The native workflow producer identity is invalid.");
  }
  const policy = parseCompileOptions(options);
  const codecMap = new Map<string, ValueCodec<JsonValue>>();
  for (const descriptor of ir.codecs) {
    const codec = native.codecs.get(descriptor.id);
    if (
      codec === undefined ||
      codec.name !== descriptor.name ||
      typeof codec.decode !== "function"
    ) {
      throw workflowFailure("validation", "The native workflow codec handle is invalid.");
    }
    if (codecMap.has(descriptor.id)) {
      throw workflowFailure("validation", "The native workflow codec identity is duplicated.");
    }
    codecMap.set(descriptor.id, codec);
  }
  const nodes = ir.graph.nodes.map((node) => compileNode(nativeNode(node, codecMap), policy));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const terminals = ir.graph.terminals.map((terminal) => {
    const output = nativeOutput(terminal.output, codecMap);
    return toPlanTerminal(terminal.key, terminal.runId, output);
  });
  if (ir.graph.conflicts.length > 0) {
    throw workflowFailure(
      "compilation",
      "The native workflow graph contains conflicting declarations.",
    );
  }
  if (nodes.length === 0 || nodes.length > policy.maxNodes) {
    throw workflowFailure(
      "compilation",
      "The native workflow graph exceeds its admitted node capacity.",
    );
  }
  const maxRetries = nodes.reduce((maximum, node) => Math.max(maximum, node.metadata.retries), 0);
  if (
    ir.capacityInputs.nodeCount !== nodes.length ||
    ir.capacityInputs.rootCount !== ir.graph.roots.length ||
    ir.capacityInputs.terminalCount !== ir.graph.terminals.length ||
    ir.capacityInputs.maxRetries !== maxRetries
  ) {
    throw workflowFailure("validation", "The native workflow capacity inputs are invalid.");
  }
  validateGraph(nodes, nodeById, ir.graph.roots, terminals);
  const layers = topologicalLayers(nodes, nodeById);
  validateWriterOwnership(layers, nodeById);
  const expectedGraphId = stableNativeGraphId(ir);
  if (ir.graphId !== expectedGraphId) {
    throw workflowFailure("validation", "The native workflow graph identity is invalid.");
  }
  const uniqueRoots = uniqueStrings(ir.graph.roots);
  const uniqueTerminals = uniqueTerminalsByShape(terminals);
  return new ExecutionPlanHandle({
    nodes,
    layers,
    roots: uniqueRoots,
    terminals: uniqueTerminals,
    capacity: policy.capacity,
    graphId: ir.graphId,
    identityDigest: stableNativeIdentity(ir, options),
    decodeResult: nativeResultDecoder(ir.graph.terminals, codecMap),
  });
}

function nativeNode(
  node: NativeWorkflowNodeIR,
  codecs: ReadonlyMap<string, ValueCodec<JsonValue>>,
): WorkflowNode {
  const inputCodec = requireNativeCodec(codecs, node.assignment.inputCodecId);
  const outputCodec = requireNativeCodec(codecs, node.assignment.outputCodecId);
  const input = nativeInput(node.input, codecs);
  const assignment: Assignment<JsonValue, JsonValue> = {
    ...(node.assignment.hasPayload
      ? { payload: nativePayload(node.assignment.payload, codecs) }
      : {}),
    input: inputCodec,
    output: outputCodec,
    metadata: node.assignment.metadata,
    ...(node.assignment.route === undefined ? {} : { route: node.assignment.route }),
  };
  return {
    id: node.id,
    name: node.name,
    input,
    dependencies: node.dependencies,
    assignment,
    inputCodec,
    outputCodec,
    metadata: node.assignment.metadata,
  };
}

function nativeInput(
  input: NativeWorkflowInputIR,
  codecs: ReadonlyMap<string, ValueCodec<JsonValue>>,
): WorkflowNode["input"] {
  if (input.kind === "root") return { kind: "root" };
  if (input.kind === "single") return { kind: "single", nodeId: input.nodeId };
  return { kind: "join", targets: input.targets.map((target) => nativeTarget(target, codecs)) };
}

function nativeTarget(
  target: NativeWorkflowOutputTargetIR,
  codecs: ReadonlyMap<string, ValueCodec<JsonValue>>,
): WorkflowOutputTarget {
  return {
    key: target.key,
    nodeId: target.nodeId,
    outputCodec: nativeOutputCodec(target, codecs),
    ...(target.source === undefined ? {} : { source: nativeOutput(target.source, codecs) }),
  };
}

function nativeOutput(
  output: NativeWorkflowOutputIR,
  codecs: ReadonlyMap<string, ValueCodec<JsonValue>>,
): WorkflowOutput {
  if (output.kind === "single") {
    return {
      kind: "single",
      nodeId: output.nodeId,
      outputCodec: requireNativeCodec(codecs, output.codecId),
    };
  }
  const targets = output.targets.map((target) => nativeTarget(target, codecs));
  return {
    kind: "join",
    targets,
    outputCodec: Object.freeze({
      name: `native-join(${targets.map((target) => target.key).join(",")})`,
      decode: (value: unknown) => decodeNativeTargets(value, targets),
    }),
  };
}

function nativeOutputCodec(
  target: NativeWorkflowOutputTargetIR,
  codecs: ReadonlyMap<string, ValueCodec<JsonValue>>,
): ValueCodec<JsonValue> {
  if (target.source === undefined) return requireNativeCodec(codecs, target.codecId);
  const source = nativeOutput(target.source, codecs);
  return Object.freeze({
    name: `native-output(${target.key})`,
    decode: (value: unknown) => decodeNativeOutput(value, source),
  });
}

function decodeNativeOutput(value: unknown, output: WorkflowOutput): JsonValue {
  return output.outputCodec.decode(value);
}

function decodeNativeTargets(value: unknown, targets: readonly WorkflowOutputTarget[]): JsonValue {
  if (!isRecord(value)) throw new Error("The native workflow join result is not an object.");
  const result: Record<string, JsonValue> = {};
  for (const target of targets) {
    if (!(target.key in value))
      throw new Error(`The native workflow result is missing ${target.key}.`);
    result[target.key] = target.outputCodec.decode(value[target.key]);
  }
  return result;
}

function nativePayload(
  value: JsonValue,
  codecs: ReadonlyMap<string, ValueCodec<JsonValue>>,
  seen = new Set<object>(),
): JsonValue {
  if (isRecord(value) && NATIVE_OUTPUT_REFERENCE_KEY in value) {
    const output = value[NATIVE_OUTPUT_REFERENCE_KEY];
    if (!isNativeWorkflowOutputIR(output)) {
      throw workflowFailure(
        "validation",
        "The native workflow payload output reference is invalid.",
      );
    }
    return makeSymbolicValue<JsonValue>(nativeOutput(output, codecs));
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value))
    throw workflowFailure("validation", "The native workflow payload is cyclic.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const item of value) result.push(nativePayload(item, codecs, seen));
      return result;
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = nativePayload(item, codecs, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function requireNativeCodec(
  codecs: ReadonlyMap<string, ValueCodec<JsonValue>>,
  id: string,
): ValueCodec<JsonValue> {
  const codec = codecs.get(id);
  if (codec === undefined)
    throw workflowFailure("validation", "The native workflow codec is missing.");
  return codec;
}

function nativeResultDecoder(
  terminals: readonly NativeWorkflowTerminalIR[],
  codecs: ReadonlyMap<string, ValueCodec<JsonValue>>,
): (value: unknown) => unknown {
  const outputs = terminals.map((terminal) => ({
    key: terminal.key,
    output: nativeOutput(terminal.output, codecs),
  }));
  return (value: unknown) => {
    if (outputs.length === 1 && outputs[0]?.key === "") {
      const output = outputs[0]?.output;
      if (!output) throw new Error("The native workflow terminal is missing.");
      return decodeNativeOutput(value, output);
    }
    if (!isRecord(value)) throw new Error("The native workflow result is not an object.");
    const result: Record<string, unknown> = {};
    for (const entry of outputs) {
      if (!(entry.key in value))
        throw new Error(`The native workflow result is missing ${entry.key}.`);
      result[entry.key] = decodeNativeOutput(value[entry.key], entry.output);
    }
    return result;
  };
}

function stableNativeGraphId(ir: WorkflowPlanIR): string {
  return stableNativeHash(
    canonicalJson({
      nodes: ir.graph.nodes,
      roots: ir.graph.roots,
      conflicts: ir.graph.conflicts,
      terminals: ir.graph.terminals,
    }),
  );
}

function stableNativeIdentity(ir: WorkflowPlanIR, options: CompileOptions): string {
  return stableNativeHash(
    canonicalJson({
      ...nativePlanJson(ir),
      compileOptions: options,
      executionMode: "native",
    }),
  );
}

function stableNativeHash(source: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `graph-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCompileOptions(input: unknown): Readonly<{
  readonly capabilities: ReadonlySet<string>;
  readonly dependencies: ReadonlySet<string>;
  readonly maxNodes: number;
  readonly capacity: PlanCapacity;
}> {
  const parsed = decodeUnknown(CompileOptionsSchema, input);
  if (Either.isLeft(parsed)) {
    throw workflowFailure("validation", "The workflow compilation policy is invalid.");
  }
  const capacity = parsed.right.capacity;
  return {
    capabilities: new Set(parsed.right.capabilities ?? []),
    dependencies: new Set(parsed.right.dependencies ?? []),
    maxNodes: parsed.right.maxNodes ?? 1_024,
    capacity: {
      planConcurrency: capacity?.planConcurrency ?? 1,
      sessionConcurrency: capacity?.sessionConcurrency ?? 1,
      codexConcurrency: capacity?.codexConcurrency ?? 1,
      maxRetries: capacity?.maxRetries ?? 0,
      maxCalls: capacity?.maxCalls ?? Number.MAX_SAFE_INTEGER,
      costMax: capacity?.costMax ?? Number.MAX_SAFE_INTEGER,
    },
  };
}

function compileNode(
  node: WorkflowNode,
  policy: Readonly<{
    readonly capabilities: ReadonlySet<string>;
    readonly dependencies: ReadonlySet<string>;
    readonly capacity: PlanCapacity;
  }>,
): CompiledNode {
  if (!isValidIdentifier(node.id) || !isValidIdentifier(node.name)) {
    throw workflowFailure("validation", `The workflow step id ${node.id} is invalid.`, {
      nodeId: node.id,
    });
  }
  if (typeof node.assignment !== "object" || node.assignment === null) {
    throw workflowFailure("validation", "The workflow assignment descriptor is invalid.", {
      nodeId: node.id,
    });
  }
  if (
    typeof node.inputCodec.name !== "string" ||
    node.inputCodec.name.length === 0 ||
    typeof node.outputCodec.name !== "string" ||
    node.outputCodec.name.length === 0 ||
    typeof node.inputCodec.decode !== "function" ||
    typeof node.outputCodec.decode !== "function"
  ) {
    throw workflowFailure("validation", "The workflow assignment codecs are invalid.", {
      nodeId: node.id,
    });
  }
  const metadata = normalizeMetadata(node.metadata, policy);
  const inputCodec = Object.freeze({
    name: node.inputCodec.name,
    decode: node.inputCodec.decode,
  });
  const outputCodec = Object.freeze({
    name: node.outputCodec.name,
    decode: node.outputCodec.decode,
  });
  const assignment = Object.freeze({
    ...node.assignment,
    input: inputCodec,
    output: outputCodec,
    metadata,
  });
  return Object.freeze({
    id: node.id,
    name: node.name,
    input: node.input,
    dependencies: Object.freeze([...node.dependencies]),
    assignment,
    inputCodec,
    outputCodec,
    metadata,
  });
}

function normalizeMetadata(
  input: AssignmentMetadata,
  policy: Readonly<{
    readonly capabilities: ReadonlySet<string>;
    readonly dependencies: ReadonlySet<string>;
    readonly capacity: PlanCapacity;
  }>,
): CompiledNodeMetadata {
  const parsed = decodeUnknown(AssignmentMetadataSchema, input);
  if (Either.isLeft(parsed)) {
    throw workflowFailure("validation", "The workflow assignment metadata is invalid.");
  }
  const metadata = parsed.right;
  const capabilities = [...(metadata.capabilities ?? [])];
  for (const capability of capabilities) {
    if (!isValidIdentifier(capability)) {
      throw workflowFailure("validation", "The workflow capability identifier is invalid.");
    }
    if (!policy.capabilities.has(capability)) {
      throw workflowFailure("validation", `The capability ${capability} is not admitted.`);
    }
  }
  const dependencies = [...(metadata.dependencies ?? [])];
  for (const dependency of dependencies) {
    if (!isValidIdentifier(dependency)) {
      throw workflowFailure("validation", "The workflow dependency identifier is invalid.");
    }
    if (!policy.dependencies.has(dependency)) {
      throw workflowFailure("validation", `The dependency ${dependency} is not admitted.`);
    }
  }
  const retries = metadata.retries ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > policy.capacity.maxRetries) {
    throw workflowFailure("validation", "The workflow retry policy is invalid.");
  }
  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    dependencies: Object.freeze(dependencies),
    retries,
    writes: Object.freeze(uniqueStrings((metadata.writes ?? []).map(normalizeWriteScope))),
    ...(metadata.when === undefined ? {} : { when: freezeCondition(metadata.when) }),
    ...(metadata.stopWhen === undefined ? {} : { stopWhen: freezePredicate(metadata.stopWhen) }),
    ...(metadata.repeatUntil === undefined
      ? {}
      : { repeatUntil: freezeRepeatUntil(metadata.repeatUntil) }),
  });
}

function normalizeWriteScope(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized.split("/").includes("..")) {
    throw workflowFailure("validation", "The workflow writer scope is invalid.");
  }
  return normalized;
}

function validateWriterOwnership(
  layers: readonly (readonly string[])[],
  nodeById: ReadonlyMap<string, CompiledNode>,
): void {
  for (const layer of layers) {
    for (let leftIndex = 0; leftIndex < layer.length; leftIndex += 1) {
      const left = nodeById.get(layer[leftIndex] ?? "");
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < layer.length; rightIndex += 1) {
        const right = nodeById.get(layer[rightIndex] ?? "");
        if (right === undefined) continue;
        const overlap = left.metadata.writes.find((leftScope) =>
          right.metadata.writes.some((rightScope) => writeScopesOverlap(leftScope, rightScope)),
        );
        if (overlap !== undefined) {
          throw workflowFailure(
            "compilation",
            `Parallel assignments ${left.id} and ${right.id} have overlapping writer ownership at ${overlap}.`,
          );
        }
      }
    }
  }
}

function writeScopesOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`) ||
    left.startsWith(`${right}#`) ||
    right.startsWith(`${left}#`)
  );
}

function validateGraph(
  nodes: readonly CompiledNode[],
  nodeById: ReadonlyMap<string, CompiledNode>,
  roots: readonly string[],
  terminals: readonly PlanTerminal[],
): void {
  if (roots.some((root) => !nodeById.has(root))) {
    throw workflowFailure("compilation", "The workflow root is not present in the graph.");
  }
  for (const node of nodes) {
    const expectedDependencies = dependenciesForInput(node.input);
    if (!sameStrings(node.dependencies, expectedDependencies)) {
      throw workflowFailure("compilation", "The workflow stage dependency index is inconsistent.", {
        nodeId: node.id,
      });
    }
    if (node.dependencies.includes(node.id)) {
      throw workflowFailure("compilation", "The workflow graph contains a self dependency.", {
        nodeId: node.id,
      });
    }
    for (const dependency of node.dependencies) {
      if (!nodeById.has(dependency)) {
        throw workflowFailure("compilation", "The workflow graph contains a dangling dependency.", {
          nodeId: node.id,
        });
      }
    }
    const condition = node.metadata.when;
    if (condition !== undefined) {
      if (condition.source === node.id) {
        throw workflowFailure("compilation", "A workflow condition cannot self-reference.", {
          nodeId: node.id,
        });
      }
      if (!nodeById.has(condition.source) || !isAncestor(nodeById, node.id, condition.source)) {
        throw workflowFailure(
          "compilation",
          "A workflow condition must reference a direct or transitive prerequisite.",
          { nodeId: node.id },
        );
      }
    }
  }
  const terminalNodeIds = terminals.flatMap((terminal) =>
    terminal.targets.flatMap((target) => outputTargetNodeIds(target)),
  );
  if (terminalNodeIds.some((nodeId) => !nodeById.has(nodeId))) {
    throw workflowFailure(
      "compilation",
      "The workflow waited terminal is not present in the graph.",
    );
  }
  const reachable = walkDependents(nodes, roots);
  if (reachable.size !== nodes.length) {
    throw workflowFailure("compilation", "The workflow contains an unreachable declared step.");
  }
  const closed = walkDependencies(nodeById, terminalNodeIds);
  if (closed.size !== nodes.length) {
    throw workflowFailure(
      "compilation",
      "The workflow contains an abandoned or fire-and-forget branch.",
    );
  }
}

function topologicalLayers(
  nodes: readonly CompiledNode[],
  nodeById: ReadonlyMap<string, CompiledNode>,
): readonly (readonly string[])[] {
  const remaining = new Set(nodes.map((node) => node.id));
  const completed = new Set<string>();
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = nodes
      .filter(
        (node) =>
          remaining.has(node.id) &&
          node.dependencies.every((dependency) => completed.has(dependency)),
      )
      .map((node) => node.id)
      .sort();
    if (ready.length === 0) {
      throw workflowFailure("compilation", "The workflow graph contains a cycle.");
    }
    layers.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  for (const id of completed) {
    if (!nodeById.has(id)) {
      throw workflowFailure("compilation", "The workflow graph index is inconsistent.");
    }
  }
  return Object.freeze(layers.map((layer) => Object.freeze(layer)));
}

function walkDependencies(
  nodeById: ReadonlyMap<string, CompiledNode>,
  startingIds: readonly string[],
): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [...startingIds];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) {
      continue;
    }
    const node = nodeById.get(id);
    if (node === undefined) {
      continue;
    }
    visited.add(id);
    pending.push(...node.dependencies);
  }
  return visited;
}

function walkDependents(
  nodes: readonly CompiledNode[],
  startingIds: readonly string[],
): ReadonlySet<string> {
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      const next = dependents.get(dependency) ?? [];
      next.push(node.id);
      dependents.set(dependency, next);
    }
  }
  const visited = new Set<string>();
  const pending = [...startingIds];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) {
      continue;
    }
    visited.add(id);
    pending.push(...(dependents.get(id) ?? []));
  }
  return visited;
}

function dependenciesForInput(input: WorkflowInputSource): readonly string[] {
  if (input.kind === "root") {
    return [];
  }
  if (input.kind === "single") {
    return [input.nodeId];
  }
  return input.targets.flatMap((target) => outputTargetNodeIds(target));
}

function outputTargetNodeIds(target: WorkflowOutputTarget): readonly string[] {
  if (target.source === undefined) {
    return [target.nodeId];
  }
  return target.source.kind === "single"
    ? [target.source.nodeId]
    : target.source.targets.flatMap((entry) => outputTargetNodeIds(entry));
}

function validateOutputTargets(targets: readonly WorkflowOutputTarget[]): void {
  if (targets.length === 0) {
    throw workflowFailure("compilation", "A workflow join must contain a target.");
  }
  const keys = new Set<string>();
  for (const target of targets) {
    if (!isValidIdentifier(target.key) || keys.has(target.key)) {
      throw workflowFailure("compilation", "The workflow join key is invalid or duplicated.");
    }
    keys.add(target.key);
    if (target.source !== undefined) {
      if (target.source.kind === "join") {
        validateOutputTargets(target.source.targets);
      }
    }
  }
}

function toPlanTerminal(
  key: string,
  runId: string,
  output:
    | Readonly<{
        readonly kind: "single";
        readonly nodeId: string;
        readonly outputCodec: ValueCodec<JsonValue>;
      }>
    | Readonly<{
        readonly kind: "join";
        readonly targets: readonly WorkflowOutputTarget[];
        readonly outputCodec: ValueCodec<JsonValue>;
      }>,
): PlanTerminal {
  const targets =
    output.kind === "single"
      ? [{ key: "", nodeId: output.nodeId, outputCodec: output.outputCodec }]
      : output.targets;
  const first = targets[0];
  if (first === undefined) {
    throw workflowFailure("compilation", "The workflow waited terminal has no output.");
  }
  return Object.freeze({
    key,
    nodeId: first.nodeId,
    runId,
    targets: Object.freeze([...targets]),
  });
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function uniqueTerminalsByShape(values: readonly PlanTerminal[]): readonly PlanTerminal[] {
  const seen = new Set<string>();
  const result: PlanTerminal[] = [];
  for (const value of values) {
    const shape = value.targets
      .map((target) => `${target.key}:${outputTargetNodeIds(target).join(",")}`)
      .join(";");
    const key = `${value.key}\u0000${value.runId}\u0000${shape}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return Object.freeze(result);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isValidIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every((item) => isJsonValue(item, seen))
    );
  } finally {
    seen.delete(value);
  }
}

function freezeCondition(input: WorkflowCondition): WorkflowCondition {
  return Object.freeze({
    source: input.source,
    path: Object.freeze([...input.path]),
    equals: input.equals,
  });
}

function freezePredicate(input: WorkflowPredicate): WorkflowPredicate {
  return Object.freeze({
    path: Object.freeze([...input.path]),
    equals: input.equals,
  });
}

function freezeRepeatUntil(input: WorkflowRepeatUntil): WorkflowRepeatUntil {
  return freezePredicate(input);
}

function isAncestor(
  nodeById: ReadonlyMap<string, CompiledNode>,
  nodeId: string,
  candidate: string,
): boolean {
  const visited = new Set<string>();
  const pending = [...(nodeById.get(nodeId)?.dependencies ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    if (current === candidate) {
      return true;
    }
    visited.add(current);
    pending.push(...(nodeById.get(current)?.dependencies ?? []));
  }
  return false;
}

function toCompilationFailure(error: unknown): WorkflowFailure {
  if (isWorkflowFailure(error)) {
    return error;
  }
  return workflowFailure("compilation", "The workflow graph could not be compiled.", {
    cause: error,
  });
}

function stablePlanId(nodes: readonly CompiledNode[], terminals: readonly PlanTerminal[]): string {
  const source = [
    ...[...nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => `${node.id}:${node.dependencies.join(",")}`),
    ...[...terminals]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(
        (terminal) =>
          `${terminal.key}:${terminal.runId}:${terminal.targets
            .map((target) => `${target.key}:${outputTargetNodeIds(target).join(",")}`)
            .join(";")}`,
      ),
  ].join("|");
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `plan-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
