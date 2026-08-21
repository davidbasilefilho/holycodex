// SPDX-License-Identifier: Apache-2.0

import type { ValueCodec } from "./schema.ts";

export type AssignmentMetadata = Readonly<{
  readonly id?: string;
  readonly capabilities?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly retries?: number;
  readonly attempt?: number;
  readonly timeoutMs?: number;
}>;

/**
 * An inert domain assignment. It contains data and validation metadata only;
 * the host agent owns execution.
 */
export type Assignment<I, O> = Readonly<{
  readonly payload: unknown;
  readonly input: ValueCodec<I>;
  readonly output: ValueCodec<O>;
  readonly metadata?: AssignmentMetadata;
  readonly route?: string;
}>;

export type StepDefinition<I, O> = Readonly<{
  readonly id: string;
  readonly assignment: Assignment<I, O>;
}>;

export type WorkflowInputSource = Readonly<
  | { readonly kind: "root" }
  | { readonly kind: "single"; readonly nodeId: string }
  | {
      readonly kind: "join";
      readonly targets: readonly WorkflowOutputTarget[];
    }
>;

export type WorkflowOutputTarget = Readonly<{
  readonly key: string;
  readonly nodeId: string;
  readonly outputCodec: ValueCodec<unknown>;
  readonly source?: WorkflowOutput;
}>;

export type WorkflowOutput = Readonly<
  | {
      readonly kind: "single";
      readonly nodeId: string;
      readonly outputCodec: ValueCodec<unknown>;
    }
  | {
      readonly kind: "join";
      readonly targets: readonly WorkflowOutputTarget[];
      readonly outputCodec: ValueCodec<unknown>;
    }
>;

export type WorkflowNode = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly input: WorkflowInputSource;
  readonly dependencies: readonly string[];
  readonly assignment: Assignment<unknown, unknown>;
  readonly inputCodec: ValueCodec<unknown>;
  readonly outputCodec: ValueCodec<unknown>;
  readonly metadata: AssignmentMetadata;
}>;

export type WorkflowGraph = Readonly<{
  readonly nodes: ReadonlyMap<string, WorkflowNode>;
  readonly entry: string;
  readonly roots: readonly string[];
  readonly output: WorkflowOutput;
  readonly conflicts: readonly string[];
}>;

export type WaitTarget = Readonly<{
  readonly key: string;
  readonly runId: string;
  readonly graph: WorkflowGraph;
  readonly output: WorkflowOutput;
  readonly outputCodec: ValueCodec<unknown>;
}>;

const workflowGraphSymbol = Symbol("holycodex.workflow.graph");
const runGraphSymbol = Symbol("holycodex.workflow.run.graph");
const runIdSymbol = Symbol("holycodex.workflow.run.id");
const waitTargetsSymbol = Symbol("holycodex.workflow.wait.targets");
const waitDecoderSymbol = Symbol("holycodex.workflow.wait.decoder");
const symbolicValueBindings = new WeakMap<object, WorkflowOutput>();

export class Workflow<I, O> {
  declare readonly input: I;
  declare readonly output: O;
  readonly [workflowGraphSymbol]: WorkflowGraph;

  protected constructor(graph: WorkflowGraph) {
    this[workflowGraphSymbol] = graph;
    Object.freeze(this);
  }
}

export class Step<I, O> extends Workflow<I, O> {
  protected constructor(graph: WorkflowGraph) {
    super(graph);
  }
}

export class Queue<I, O> extends Workflow<I, O> {
  protected constructor(graph: WorkflowGraph) {
    super(graph);
  }
}

export class Run<I, O> {
  declare readonly input: I;
  declare readonly result: O;
  readonly [runGraphSymbol]: WorkflowGraph;
  readonly [runIdSymbol]: string;

  protected constructor(graph: WorkflowGraph, runId: string) {
    this[runGraphSymbol] = graph;
    this[runIdSymbol] = runId;
    Object.freeze(this);
  }
}

export class Wait<I = unknown, O = I> {
  declare readonly input: I;
  declare readonly result: O;
  readonly [waitTargetsSymbol]: readonly WaitTarget[];
  readonly [waitDecoderSymbol]: (value: unknown) => O;

  protected constructor(targets: readonly WaitTarget[], decoder: (value: unknown) => O) {
    this[waitTargetsSymbol] = Object.freeze([...targets]);
    this[waitDecoderSymbol] = decoder;
    Object.freeze(this);
  }
}

class StepHandle<I, O> extends Step<I, O> {
  constructor(graph: WorkflowGraph) {
    super(graph);
  }
}

class QueueHandle<I, O> extends Queue<I, O> {
  constructor(graph: WorkflowGraph) {
    super(graph);
  }
}

class RunHandle<I, O> extends Run<I, O> {
  constructor(graph: WorkflowGraph, runId: string) {
    super(graph, runId);
  }
}

class WaitHandle<I, O> extends Wait<I, O> {
  constructor(targets: readonly WaitTarget[], decoder: (value: unknown) => O) {
    super(targets, decoder);
  }
}

export type NamedWaitResult<Named extends object> = {
  readonly [Key in keyof Named]: WaitableOutput<Named[Key]>;
};

export type WorkflowStage<I, O> = Workflow<I, O> | Wait<I, O>;

type WaitableInput<Value> =
  Value extends Workflow<infer Input, infer _Output>
    ? Input
    : Value extends Run<infer Input, infer _Output>
      ? Input
      : never;
type WaitableOutput<Value> =
  Value extends Workflow<infer _Input, infer Output>
    ? Output
    : Value extends Run<infer _Input, infer Output>
      ? Output
      : never;
type NamedWaitInput<Named extends object> = WaitableInput<Named[keyof Named]>;
type ExactType<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type NamedWaitValidation<Named extends object> = {
  readonly [Key in keyof Named]: [WaitableInput<Named[Key]>] extends [never]
    ? never
    : ExactType<WaitableInput<Named[Key]>, NamedWaitInput<Named>> extends true
      ? Named[Key]
      : never;
};

type QueueStage<Current, Output> =
  | Workflow<Current, Output>
  | Wait<Current, Output>
  | ((input: Current) => Workflow<Current, Output> | Wait<Current, Output>);

export interface WorkflowDsl {
  readonly step: <I, O>(definition: StepDefinition<I, O>) => Step<I, O>;
  readonly queue: {
    <I, O>(first: Workflow<I, O>): Queue<I, O>;
    <I, O, O1>(first: Workflow<I, O>, stage1: QueueStage<O, O1>): Queue<I, O1>;
    <I, O, O1, O2>(
      first: Workflow<I, O>,
      stage1: QueueStage<O, O1>,
      stage2: QueueStage<O1, O2>,
    ): Queue<I, O2>;
    <I, O, O1, O2, O3>(
      first: Workflow<I, O>,
      stage1: QueueStage<O, O1>,
      stage2: QueueStage<O1, O2>,
      stage3: QueueStage<O2, O3>,
    ): Queue<I, O3>;
    <I, O, O1, O2, O3, O4>(
      first: Workflow<I, O>,
      stage1: QueueStage<O, O1>,
      stage2: QueueStage<O1, O2>,
      stage3: QueueStage<O2, O3>,
      stage4: QueueStage<O3, O4>,
    ): Queue<I, O4>;
    <I, O, O1, O2, O3, O4, O5>(
      first: Workflow<I, O>,
      stage1: QueueStage<O, O1>,
      stage2: QueueStage<O1, O2>,
      stage3: QueueStage<O2, O3>,
      stage4: QueueStage<O3, O4>,
      stage5: QueueStage<O4, O5>,
    ): Queue<I, O5>;
    <I, O, O1, O2, O3, O4, O5, O6>(
      first: Workflow<I, O>,
      stage1: QueueStage<O, O1>,
      stage2: QueueStage<O1, O2>,
      stage3: QueueStage<O2, O3>,
      stage4: QueueStage<O3, O4>,
      stage5: QueueStage<O4, O5>,
      stage6: QueueStage<O5, O6>,
    ): Queue<I, O6>;
    <I, O, O1, O2, O3, O4, O5, O6, O7>(
      first: Workflow<I, O>,
      stage1: QueueStage<O, O1>,
      stage2: QueueStage<O1, O2>,
      stage3: QueueStage<O2, O3>,
      stage4: QueueStage<O3, O4>,
      stage5: QueueStage<O4, O5>,
      stage6: QueueStage<O5, O6>,
      stage7: QueueStage<O6, O7>,
    ): Queue<I, O7>;
    <I, O, O1, O2, O3, O4, O5, O6, O7, O8>(
      first: Workflow<I, O>,
      stage1: QueueStage<O, O1>,
      stage2: QueueStage<O1, O2>,
      stage3: QueueStage<O2, O3>,
      stage4: QueueStage<O3, O4>,
      stage5: QueueStage<O4, O5>,
      stage6: QueueStage<O5, O6>,
      stage7: QueueStage<O6, O7>,
      stage8: QueueStage<O7, O8>,
    ): Queue<I, O8>;
  };
  readonly start: <I, O>(workflow: Workflow<I, O>) => Run<I, O>;
  readonly wait: {
    <I, O>(workflow: Workflow<I, O>): Wait<I, O>;
    <I, O>(run: Run<I, O>): Wait<I, O>;
    <Named extends object>(
      values: Named & NamedWaitValidation<Named>,
    ): Wait<NamedWaitInput<Named>, NamedWaitResult<Named>>;
  };
}

function step<I, O>(definition: StepDefinition<I, O>): Step<I, O> {
  const id = definition.id;
  const assignment = normalizeAssignment(definition.assignment);
  const inputCodec = toUnknownCodec(assignment.input);
  const outputCodec = toUnknownCodec(assignment.output);
  const nodeAssignment: Assignment<unknown, unknown> = {
    payload: assignment.payload,
    input: inputCodec,
    output: outputCodec,
    ...(assignment.route === undefined ? {} : { route: assignment.route }),
    ...(assignment.metadata === undefined ? {} : { metadata: assignment.metadata }),
  };
  const node: WorkflowNode = {
    id,
    name: id,
    input: { kind: "root" },
    dependencies: Object.freeze([]),
    assignment: nodeAssignment,
    inputCodec,
    outputCodec,
    metadata: assignment.metadata ?? {},
  };
  const output: WorkflowOutput = {
    kind: "single",
    nodeId: node.id,
    outputCodec: node.outputCodec,
  };
  return new StepHandle(
    freezeGraph({
      nodes: readonlyMap([[node.id, node]]),
      entry: node.id,
      roots: Object.freeze([node.id]),
      output,
      conflicts: Object.freeze([]),
    }),
  );
}

function queue<I, O, Stages extends readonly unknown[]>(
  first: Workflow<I, O>,
  ...stages: Stages
): Queue<I, unknown>;
function queue(
  first: Workflow<unknown, unknown>,
  ...stages: readonly unknown[]
): Queue<unknown, unknown> {
  let graph = readWorkflowGraph(first);
  for (const stage of stages) {
    const source = graph.output;
    const declaration = typeof stage === "function" ? invokeStage(stage, source) : stage;
    const next = toStageGraph(declaration);
    graph = connectGraphs(graph, next);
  }
  return new QueueHandle(graph);
}

function start<I, O>(root: Workflow<I, O>): Run<I, O> {
  const graph = readWorkflowGraph(root);
  return new RunHandle(graph, stableRunId(graph));
}

function wait<I, O>(workflowValue: Workflow<I, O>): Wait<I, O>;
function wait<I, O>(run: Run<I, O>): Wait<I, O>;
function wait<Named extends object>(
  values: Named & NamedWaitValidation<Named>,
): Wait<NamedWaitInput<Named>, NamedWaitResult<Named>>;
function wait(input: unknown): Wait<unknown, unknown> {
  if (input instanceof Workflow || input instanceof Run) {
    const run = input instanceof Run ? input : start(input);
    const target = targetFromRun(run, "");
    return new WaitHandle([target], (value) => decodeOutput(value, target.output));
  }
  if (!isRecord(input)) {
    throw new Error("The workflow wait input is invalid.");
  }
  const targets: WaitTarget[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!(value instanceof Workflow) && !(value instanceof Run)) {
      throw new Error(`The named workflow wait entry ${key} is not a workflow or run.`);
    }
    const run = value instanceof Run ? value : start(value);
    targets.push(targetFromRun(run, key));
  }
  if (targets.length === 0) {
    throw new Error("A named workflow wait requires at least one value.");
  }
  return new WaitHandle(targets, (value) => decodeNamedWait(value, targets));
}

export const workflow: WorkflowDsl = Object.freeze({
  step,
  queue,
  start,
  wait,
});

export function readWorkflowGraph<I, O>(value: Workflow<I, O>): WorkflowGraph {
  return value[workflowGraphSymbol];
}

export function readRunGraph<I, O>(value: Run<I, O>): WorkflowGraph {
  return value[runGraphSymbol];
}

export function readRunId<I, O>(value: Run<I, O>): string {
  return value[runIdSymbol];
}

export function readWaitTargets<I, O>(value: Wait<I, O>): readonly WaitTarget[] {
  return value[waitTargetsSymbol];
}

export function readWaitDecoder<I, O>(value: Wait<I, O>): (value: unknown) => O {
  return value[waitDecoderSymbol];
}

export function readOutputCodec(output: WorkflowOutput): ValueCodec<unknown> {
  return output.outputCodec;
}

export function makeSymbolicValue<T>(source: WorkflowOutput): T {
  const target = {};
  const value = new Proxy(target, {
    defineProperty: () => symbolicValueFailure(),
    deleteProperty: () => symbolicValueFailure(),
    get: () => symbolicValueFailure(),
    getOwnPropertyDescriptor: () => symbolicValueFailure(),
    getPrototypeOf: () => symbolicValueFailure(),
    has: () => symbolicValueFailure(),
    isExtensible: () => symbolicValueFailure(),
    ownKeys: () => symbolicValueFailure(),
    preventExtensions: () => symbolicValueFailure(),
    set: () => symbolicValueFailure(),
    setPrototypeOf: () => symbolicValueFailure(),
  });
  symbolicValueBindings.set(value, source);
  // The token is intentionally opaque at runtime; only declaration internals receive it.
  return value as T;
}

export function readSymbolicSource(value: object): WorkflowOutput | undefined {
  return symbolicValueBindings.get(value);
}

function toUnknownCodec<T>(codec: ValueCodec<T>): ValueCodec<unknown> {
  return Object.freeze({
    name: codec.name,
    decode: (value: unknown) => codec.decode(value),
  });
}

function normalizeAssignment<I, O>(assignment: Assignment<I, O>): Assignment<I, O> {
  if (
    typeof assignment !== "object" ||
    assignment === null ||
    typeof assignment.input?.decode !== "function" ||
    typeof assignment.output?.decode !== "function" ||
    typeof assignment.input.name !== "string" ||
    assignment.input.name.length === 0 ||
    typeof assignment.output.name !== "string" ||
    assignment.output.name.length === 0
  ) {
    throw new Error("A workflow assignment descriptor is invalid.");
  }
  if (containsCallable(assignment.payload)) {
    throw new Error("A workflow assignment payload must be inert data.");
  }
  const metadata =
    assignment.metadata === undefined ? undefined : Object.freeze({ ...assignment.metadata });
  return Object.freeze({
    payload: assignment.payload,
    input: assignment.input,
    output: assignment.output,
    ...(assignment.route === undefined ? {} : { route: assignment.route }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function toStageGraph(value: unknown): WorkflowGraph {
  if (value instanceof Workflow) {
    return readWorkflowGraph(value);
  }
  if (value instanceof Wait) {
    const targets = readWaitTargets(value);
    let graph: WorkflowGraph | undefined;
    for (const target of targets) {
      graph = graph === undefined ? target.graph : mergeIndependentGraphs(graph, target.graph);
    }
    if (graph === undefined) {
      throw new Error("A workflow wait has no target graph.");
    }
    const outputTargets = targets.map((target) => outputTargetsForWaitTarget(target));
    const flattened = outputTargets.flat();
    return freezeGraph({
      ...graph,
      output:
        targets.length === 1 && targets[0]?.key === ""
          ? (targets[0]?.output ?? graph.output)
          : joinOutput(flattened),
    });
  }
  throw new Error("A workflow queue stage must return a workflow or wait.");
}

type StageCallback = (input: unknown) => unknown;

function invokeStage(stage: unknown, source: WorkflowOutput): unknown {
  const symbolic = makeSymbolicValue<unknown>(source);
  if (!isStageCallback(stage)) {
    throw new Error("A workflow queue callback is not callable.");
  }
  return stage(symbolic);
}

function isStageCallback(value: unknown): value is StageCallback {
  return typeof value === "function";
}

function connectGraphs(left: WorkflowGraph, right: WorkflowGraph): WorkflowGraph {
  const nodes = new Map(left.nodes);
  const conflicts = [...left.conflicts, ...right.conflicts];
  for (const [id, node] of right.nodes) {
    const rebound = rebindNode(node, left.output);
    const existing = nodes.get(id);
    if (existing === undefined) {
      nodes.set(id, rebound);
    } else if (existing.assignment !== rebound.assignment || existing.input !== rebound.input) {
      conflicts.push(id);
    }
  }
  return freezeGraph({
    nodes: readonlyMap(nodes),
    entry: left.entry,
    roots: left.roots,
    output: right.output,
    conflicts: Object.freeze(conflicts),
  });
}

function mergeIndependentGraphs(left: WorkflowGraph, right: WorkflowGraph): WorkflowGraph {
  const nodes = new Map(left.nodes);
  const conflicts = [...left.conflicts, ...right.conflicts];
  for (const [id, node] of right.nodes) {
    const existing = nodes.get(id);
    if (existing === undefined) {
      nodes.set(id, node);
    } else if (existing.assignment !== node.assignment || existing.input !== node.input) {
      conflicts.push(id);
    }
  }
  return freezeGraph({
    nodes: readonlyMap(nodes),
    entry: left.entry,
    roots: Object.freeze([...new Set([...left.roots, ...right.roots])]),
    output: left.output,
    conflicts: Object.freeze(conflicts),
  });
}

function rebindNode(node: WorkflowNode, source: WorkflowOutput): WorkflowNode {
  if (node.input.kind !== "root") {
    return node;
  }
  const input = inputSourceFromOutput(source);
  return Object.freeze({
    ...node,
    input,
    dependencies: dependenciesForInput(input),
  });
}

function inputSourceFromOutput(output: WorkflowOutput): WorkflowInputSource {
  return output.kind === "single"
    ? { kind: "single", nodeId: output.nodeId }
    : { kind: "join", targets: output.targets };
}

function dependenciesForInput(input: WorkflowInputSource): readonly string[] {
  if (input.kind === "root") {
    return Object.freeze([]);
  }
  if (input.kind === "single") {
    return Object.freeze([input.nodeId]);
  }
  return Object.freeze(input.targets.flatMap((target) => outputTargetNodeIds(target)));
}

function outputTargetNodeIds(target: WorkflowOutputTarget): readonly string[] {
  if (target.source === undefined) {
    return [target.nodeId];
  }
  return target.source.kind === "single"
    ? [target.source.nodeId]
    : target.source.targets.flatMap((entry) => outputTargetNodeIds(entry));
}

function targetFromRun<I, O>(run: Run<I, O>, key: string): WaitTarget {
  const graph = readRunGraph(run);
  const output = graph.output;
  return Object.freeze({
    key,
    runId: readRunId(run),
    graph,
    output,
    outputCodec: readOutputCodec(output),
  });
}

function outputTargetsForWaitTarget(target: WaitTarget): readonly WorkflowOutputTarget[] {
  return target.output.kind === "single"
    ? Object.freeze([
        Object.freeze({
          key: target.key,
          nodeId: target.output.nodeId,
          outputCodec: target.output.outputCodec,
        }),
      ])
    : Object.freeze([
        Object.freeze({
          key: target.key,
          nodeId: target.output.targets[0]?.nodeId ?? "",
          outputCodec: target.output.outputCodec,
          source: target.output,
        }),
      ]);
}

function joinOutput(targets: readonly WorkflowOutputTarget[]): WorkflowOutput {
  return Object.freeze({
    kind: "join",
    targets: Object.freeze([...targets]),
    outputCodec: joinCodec(targets),
  });
}

function joinCodec(targets: readonly WorkflowOutputTarget[]): ValueCodec<unknown> {
  return Object.freeze({
    name: `join(${targets.map((target) => target.key).join(",")})`,
    decode: (value: unknown) => decodeOutputTargets(value, targets),
  });
}

function decodeOutput(value: unknown, output: WorkflowOutput): unknown {
  return output.outputCodec.decode(value);
}

function decodeNamedWait(value: unknown, targets: readonly WaitTarget[]): unknown {
  if (!isRecord(value)) {
    throw new Error("The named workflow result is not an object.");
  }
  const pairs: Array<readonly [string, unknown]> = [];
  for (const target of targets) {
    if (!(target.key in value)) {
      throw new Error(`The named workflow result is missing ${target.key}.`);
    }
    pairs.push([target.key, decodeOutput(value[target.key], target.output)]);
  }
  return Object.fromEntries(pairs);
}

function decodeOutputTargets(value: unknown, targets: readonly WorkflowOutputTarget[]): unknown {
  if (!isRecord(value)) {
    throw new Error("The workflow join result is not an object.");
  }
  const pairs: Array<readonly [string, unknown]> = [];
  for (const target of targets) {
    if (!(target.key in value)) {
      throw new Error(`The workflow join result is missing ${target.key}.`);
    }
    pairs.push([target.key, target.outputCodec.decode(value[target.key])]);
  }
  return Object.fromEntries(pairs);
}

function stableRunId(graph: WorkflowGraph): string {
  const source = [
    ...graph.roots,
    ...graph.nodes.keys(),
    graph.output.kind === "single"
      ? graph.output.nodeId
      : graph.output.targets.map((target) => `${target.key}:${target.nodeId}`).join(","),
  ].join("|");
  return `run-${stableHash(source)}`;
}

function stableHash(source: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function readonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const map = new Map(entries);
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

function freezeGraph(graph: WorkflowGraph): WorkflowGraph {
  const nodes = [...graph.nodes.entries()].map(
    ([id, node]) =>
      [
        id,
        Object.freeze({
          ...node,
          input: freezeInputSource(node.input),
          dependencies: Object.freeze([...node.dependencies]),
          assignment: Object.freeze({ ...node.assignment }),
          metadata: Object.freeze({ ...node.metadata }),
        }),
      ] as const,
  );
  return Object.freeze({
    nodes: readonlyMap(nodes),
    entry: graph.entry,
    roots: Object.freeze([...graph.roots]),
    output: freezeOutput(graph.output),
    conflicts: Object.freeze([...graph.conflicts]),
  });
}

function freezeInputSource(source: WorkflowInputSource): WorkflowInputSource {
  return source.kind === "root"
    ? Object.freeze({ kind: "root" })
    : source.kind === "single"
      ? Object.freeze({ kind: "single", nodeId: source.nodeId })
      : Object.freeze({
          kind: "join",
          targets: Object.freeze(source.targets.map(freezeOutputTarget)),
        });
}

function freezeOutput(output: WorkflowOutput): WorkflowOutput {
  return output.kind === "single"
    ? Object.freeze({ ...output })
    : Object.freeze({
        ...output,
        targets: Object.freeze(output.targets.map(freezeOutputTarget)),
      });
}

function freezeOutputTarget(target: WorkflowOutputTarget): WorkflowOutputTarget {
  return Object.freeze({
    ...target,
    ...(target.source === undefined ? {} : { source: freezeOutput(target.source) }),
  });
}

function containsCallable(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "function") {
    return true;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  if (symbolicValueBindings.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsCallable(entry, seen));
  }
  return Object.values(value).some((entry) => containsCallable(entry, seen));
}

function symbolicValueFailure(): never {
  throw new Error("A callback-stage symbolic value is opaque until workflow execution.");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
