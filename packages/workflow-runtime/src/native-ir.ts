// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  type JsonObject,
  type JsonValue,
} from "@holycodex/core";
import type { AssignmentMetadata } from "./dsl.ts";
import type { ValueCodec } from "./schema.ts";

/** The ABI version for the native TypeScript source loader. */
export const NATIVE_WORKFLOW_ABI_VERSION = "native-workflow-ir-1" as const;
export const NATIVE_OUTPUT_REFERENCE_KEY = "__holycodex_workflow_output__" as const;

export type NativeWorkflowInputIR = Readonly<
  | { readonly kind: "root" }
  | { readonly kind: "single"; readonly nodeId: string }
  | {
      readonly kind: "join";
      readonly targets: readonly NativeWorkflowOutputTargetIR[];
    }
>;

export type NativeWorkflowOutputIR = Readonly<
  | { readonly kind: "single"; readonly nodeId: string; readonly codecId: string }
  | {
      readonly kind: "join";
      readonly targets: readonly NativeWorkflowOutputTargetIR[];
    }
>;

export type NativeWorkflowOutputTargetIR = Readonly<{
  readonly key: string;
  readonly nodeId: string;
  readonly codecId: string;
  readonly source?: NativeWorkflowOutputIR;
}>;

export type NativeWorkflowCodecIR = Readonly<{
  readonly id: string;
  readonly name: string;
}>;

export type NativeWorkflowAssignmentIR = Readonly<{
  readonly hasPayload: boolean;
  readonly payload: JsonValue;
  readonly inputCodecId: string;
  readonly outputCodecId: string;
  readonly metadata: AssignmentMetadata;
  readonly route?: string;
}>;

export type NativeWorkflowNodeIR = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly input: NativeWorkflowInputIR;
  readonly dependencies: readonly string[];
  readonly assignment: NativeWorkflowAssignmentIR;
}>;

export type NativeWorkflowTerminalIR = Readonly<{
  readonly key: string;
  readonly runId: string;
  readonly output: NativeWorkflowOutputIR;
}>;

export type NativeWorkflowCapacityInputsIR = Readonly<{
  readonly nodeCount: number;
  readonly rootCount: number;
  readonly terminalCount: number;
  readonly maxRetries: number;
}>;

/**
 * Immutable, inert data emitted by the bounded native source evaluator.
 * Codec decoder functions intentionally live outside this value as sandbox handles.
 */
export type WorkflowPlanIR = Readonly<{
  readonly version: 1;
  readonly abiVersion: typeof NATIVE_WORKFLOW_ABI_VERSION;
  readonly executionMode: "native";
  readonly sourceDigest: string;
  readonly transformedDigest: string;
  readonly identityDigest: string;
  readonly graphId: string;
  readonly capacityInputs: NativeWorkflowCapacityInputsIR;
  readonly graph: Readonly<{
    readonly nodes: readonly NativeWorkflowNodeIR[];
    readonly roots: readonly string[];
    readonly conflicts: readonly string[];
    readonly terminals: readonly NativeWorkflowTerminalIR[];
  }>;
  readonly codecs: readonly NativeWorkflowCodecIR[];
}>;

export type NativeWorkflowIdentityInput = Readonly<{
  readonly abiVersion: typeof NATIVE_WORKFLOW_ABI_VERSION;
  readonly executionMode: "native";
  readonly sourceDigest: string;
  readonly transformedDigest: string;
  readonly graph: Readonly<{
    readonly nodes: readonly NativeWorkflowNodeIR[];
    readonly roots: readonly string[];
    readonly conflicts: readonly string[];
    readonly terminals: readonly NativeWorkflowTerminalIR[];
  }>;
  readonly codecs: readonly NativeWorkflowCodecIR[];
  readonly capacityInputs: NativeWorkflowCapacityInputsIR;
  readonly compileOptions: JsonValue;
}>;

/** A native plan together with decoder proxies backed by its QuickJS sandbox. */
export type NativeWorkflow = Readonly<{
  readonly ir: WorkflowPlanIR;
  readonly codecs: ReadonlyMap<string, ValueCodec<unknown>>;
  readonly dispose: () => void;
}>;

/** Compute the producer identity for the immutable native workflow IR envelope. */
export async function nativeWorkflowIdentityDigest(
  input: NativeWorkflowIdentityInput,
): Promise<string> {
  return await domainSeparatedSha256("holycodex-native-workflow-identity", [
    canonicalJsonUtf8({
      abiVersion: input.abiVersion,
      executionMode: input.executionMode,
      sourceDigest: input.sourceDigest,
      transformedDigest: input.transformedDigest,
      graph: input.graph,
      codecs: input.codecs,
      capacityInputs: input.capacityInputs,
      compileOptions: input.compileOptions,
    }),
  ]);
}

export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
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

/** Deep-freeze an accepted plan value before it crosses into host scheduling. */
export function freezeWorkflowPlanIR(input: WorkflowPlanIR): WorkflowPlanIR {
  const nodes = input.graph.nodes.map((node) =>
    Object.freeze({
      ...node,
      input: freezeInput(node.input),
      dependencies: Object.freeze([...node.dependencies]),
      assignment: Object.freeze({
        ...node.assignment,
        payload: freezeJson(node.assignment.payload),
        metadata: freezeMetadata(node.assignment.metadata),
      }),
    }),
  );
  const terminals = input.graph.terminals.map((terminal) =>
    Object.freeze({ ...terminal, output: freezeOutput(terminal.output) }),
  );
  return Object.freeze({
    ...input,
    codecs: Object.freeze(input.codecs.map((codec) => Object.freeze({ ...codec }))),
    capacityInputs: Object.freeze({ ...input.capacityInputs }),
    graph: Object.freeze({
      ...input.graph,
      nodes: Object.freeze(nodes),
      roots: Object.freeze([...input.graph.roots]),
      conflicts: Object.freeze([...input.graph.conflicts]),
      terminals: Object.freeze(terminals),
    }),
  });
}

/** Validate the inert native plan envelope and its graph/codec references. */
export function validateWorkflowPlanIR(value: unknown): value is WorkflowPlanIR {
  if (!isRecord(value)) return false;
  if (
    value["version"] !== 1 ||
    value["abiVersion"] !== NATIVE_WORKFLOW_ABI_VERSION ||
    value["executionMode"] !== "native" ||
    !isDigest(value["sourceDigest"]) ||
    !isDigest(value["transformedDigest"]) ||
    !isDigest(value["identityDigest"]) ||
    typeof value["graphId"] !== "string" ||
    !isCapacityInputs(value["capacityInputs"]) ||
    !isRecord(value["graph"]) ||
    !Array.isArray(value["codecs"])
  ) {
    return false;
  }
  const codecs = value["codecs"];
  const graph = value["graph"];
  if (!Array.isArray(codecs) || !codecs.every(isCodec) || !isRecord(graph)) return false;
  const nodes = graph["nodes"];
  const roots = graph["roots"];
  const conflicts = graph["conflicts"];
  const terminals = graph["terminals"];
  if (!Array.isArray(nodes) || !nodes.every(isNode)) return false;
  if (!Array.isArray(roots) || !roots.every(isString)) return false;
  if (!Array.isArray(conflicts) || !conflicts.every(isString)) return false;
  return (
    Array.isArray(terminals) &&
    terminals.every(isTerminal) &&
    nodes.every(
      (node) =>
        codecs.some((codec) => codec.id === node.assignment.inputCodecId) &&
        codecs.some((codec) => codec.id === node.assignment.outputCodecId),
    )
  );
}

/** Return the digestable JSON projection of a native plan without its digest field. */
export function nativePlanJson(input: WorkflowPlanIR): JsonObject {
  const value = {
    version: input.version,
    abiVersion: input.abiVersion,
    executionMode: input.executionMode,
    sourceDigest: input.sourceDigest,
    transformedDigest: input.transformedDigest,
    graphId: input.graphId,
    capacityInputs: input.capacityInputs,
    graph: input.graph,
    codecs: input.codecs,
  };
  canonicalJson(value);
  if (!isJsonValue(value)) {
    throw new Error("The workflow plan IR is not JSON.");
  }
  return value;
}

function freezeInput(input: NativeWorkflowInputIR): NativeWorkflowInputIR {
  return input.kind === "root"
    ? Object.freeze({ kind: "root" })
    : input.kind === "single"
      ? Object.freeze({ kind: "single", nodeId: input.nodeId })
      : Object.freeze({
          kind: "join",
          targets: Object.freeze(input.targets.map(freezeTarget)),
        });
}

function freezeOutput(input: NativeWorkflowOutputIR): NativeWorkflowOutputIR {
  return input.kind === "single"
    ? Object.freeze({ ...input })
    : Object.freeze({
        kind: "join",
        targets: Object.freeze(input.targets.map(freezeTarget)),
      });
}

function freezeTarget(input: NativeWorkflowOutputTargetIR): NativeWorkflowOutputTargetIR {
  return Object.freeze({
    ...input,
    ...(input.source === undefined ? {} : { source: freezeOutput(input.source) }),
  });
}

function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJson(entry)));
  }
  const entries = Object.entries(value).map(([key, entry]) => [key, freezeJson(entry)] as const);
  return Object.freeze(Object.fromEntries(entries));
}

function freezeMetadata(metadata: AssignmentMetadata): AssignmentMetadata {
  return Object.freeze({
    ...metadata,
    ...(metadata.capabilities === undefined
      ? {}
      : { capabilities: Object.freeze([...metadata.capabilities]) }),
    ...(metadata.dependencies === undefined
      ? {}
      : { dependencies: Object.freeze([...metadata.dependencies]) }),
    ...(metadata.writes === undefined ? {} : { writes: Object.freeze([...metadata.writes]) }),
    ...(metadata.when === undefined
      ? {}
      : {
          when: Object.freeze({
            ...metadata.when,
            path: Object.freeze([...metadata.when.path]),
            equals: freezeJson(metadata.when.equals),
          }),
        }),
    ...(metadata.stopWhen === undefined
      ? {}
      : {
          stopWhen: Object.freeze({
            ...metadata.stopWhen,
            path: Object.freeze([...metadata.stopWhen.path]),
            equals: freezeJson(metadata.stopWhen.equals),
          }),
        }),
    ...(metadata.repeatUntil === undefined
      ? {}
      : {
          repeatUntil: Object.freeze({
            ...metadata.repeatUntil,
            path: Object.freeze([...metadata.repeatUntil.path]),
            equals: freezeJson(metadata.repeatUntil.equals),
          }),
        }),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isCodec(value: unknown): value is NativeWorkflowCodecIR {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string";
}

function isInput(value: unknown): value is NativeWorkflowInputIR {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  if (value["kind"] === "root") return true;
  if (value["kind"] === "single") return typeof value["nodeId"] === "string";
  const targets = value["targets"];
  return value["kind"] === "join" && Array.isArray(targets) && targets.every(isTarget);
}

function isOutput(value: unknown): value is NativeWorkflowOutputIR {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  if (value["kind"] === "single") {
    return typeof value["nodeId"] === "string" && typeof value["codecId"] === "string";
  }
  const targets = value["targets"];
  return value["kind"] === "join" && Array.isArray(targets) && targets.every(isTarget);
}

export function isNativeWorkflowOutputIR(value: unknown): value is NativeWorkflowOutputIR {
  return isOutput(value);
}

function isTarget(value: unknown): value is NativeWorkflowOutputTargetIR {
  return (
    isRecord(value) &&
    typeof value["key"] === "string" &&
    typeof value["nodeId"] === "string" &&
    typeof value["codecId"] === "string" &&
    (value["source"] === undefined || isOutput(value["source"]))
  );
}

function isAssignment(value: unknown): value is NativeWorkflowAssignmentIR {
  return (
    isRecord(value) &&
    typeof value["hasPayload"] === "boolean" &&
    isJsonValue(value["payload"]) &&
    typeof value["inputCodecId"] === "string" &&
    typeof value["outputCodecId"] === "string" &&
    isRecord(value["metadata"]) &&
    Object.values(value["metadata"]).every((entry) => isJsonValue(entry)) &&
    (value["route"] === undefined || typeof value["route"] === "string")
  );
}

function isNode(value: unknown): value is NativeWorkflowNodeIR {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["name"] === "string" &&
    isInput(value["input"]) &&
    Array.isArray(value["dependencies"]) &&
    value["dependencies"].every(isString) &&
    isAssignment(value["assignment"])
  );
}

function isTerminal(value: unknown): value is NativeWorkflowTerminalIR {
  return (
    isRecord(value) &&
    typeof value["key"] === "string" &&
    typeof value["runId"] === "string" &&
    isOutput(value["output"])
  );
}

function isCapacityInputs(value: unknown): value is NativeWorkflowCapacityInputsIR {
  return (
    isRecord(value) &&
    ["nodeCount", "rootCount", "terminalCount", "maxRetries"].every(
      (key) => typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= 0,
    )
  );
}
