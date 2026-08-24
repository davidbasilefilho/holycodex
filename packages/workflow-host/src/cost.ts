// SPDX-License-Identifier: Apache-2.0

import { codexModelIdFor, codexServiceTierFor, type ExecutionUsage } from "@holycodex/codex";
import type { Effort, RouteDefinition, ServiceTier } from "@holycodex/core";
import type { CapacityLedgerSnapshot } from "@holycodex/workflow-runtime";
import type { OperationLifecycle } from "./schemas.ts";

export const COST_UNIT_SCALE = 1_000_000;
export const PRICING_VERSION = "luna-token-equivalent-v1";
export const LONG_CONTEXT_INPUT_THRESHOLD = 272_000;

export type CostUnits = number;
export type PricingServiceTier = "standard" | "priority";
export type PricingKey = `${string}:${PricingServiceTier}:${"short" | "long"}`;

export type PricingRate = Readonly<{
  readonly uncachedInputPerMillion: CostUnits;
  readonly cachedInputPerMillion: CostUnits;
  readonly outputPerMillion: CostUnits;
}>;

export type PricingEntry = Readonly<{
  readonly key: PricingKey;
  readonly wireModel: string;
  readonly serviceTier: PricingServiceTier;
  readonly contextClass: "short" | "long";
  readonly rate: PricingRate;
}>;

const STANDARD_SHORT_RATE = Object.freeze({
  uncachedInputPerMillion: 200_000,
  cachedInputPerMillion: 20_000,
  outputPerMillion: 1_200_000,
} satisfies PricingRate);
const STANDARD_LONG_RATE = Object.freeze({
  uncachedInputPerMillion: 400_000,
  cachedInputPerMillion: 40_000,
  outputPerMillion: 1_800_000,
} satisfies PricingRate);
const PRIORITY_SHORT_RATE = Object.freeze({
  uncachedInputPerMillion: 400_000,
  cachedInputPerMillion: 40_000,
  outputPerMillion: 2_400_000,
} satisfies PricingRate);
const PRIORITY_LONG_RATE = Object.freeze({
  uncachedInputPerMillion: 800_000,
  cachedInputPerMillion: 80_000,
  outputPerMillion: 3_600_000,
} satisfies PricingRate);

function pricingEntry(
  wireModel: string,
  serviceTier: PricingServiceTier,
  contextClass: "short" | "long",
  rate: PricingRate,
): PricingEntry {
  return Object.freeze({
    key: `${wireModel}:${serviceTier}:${contextClass}` as PricingKey,
    wireModel,
    serviceTier,
    contextClass,
    rate,
  });
}

/** The immutable pricing authority for canonical wire model and protocol tier. */
export const PRICING_REGISTRY: Readonly<Record<PricingKey, PricingEntry>> = Object.freeze({
  "gpt-5.6-luna:standard:short": pricingEntry(
    "gpt-5.6-luna",
    "standard",
    "short",
    STANDARD_SHORT_RATE,
  ),
  "gpt-5.6-luna:standard:long": pricingEntry(
    "gpt-5.6-luna",
    "standard",
    "long",
    STANDARD_LONG_RATE,
  ),
  "gpt-5.6-luna:priority:short": pricingEntry(
    "gpt-5.6-luna",
    "priority",
    "short",
    PRIORITY_SHORT_RATE,
  ),
  "gpt-5.6-luna:priority:long": pricingEntry(
    "gpt-5.6-luna",
    "priority",
    "long",
    PRIORITY_LONG_RATE,
  ),
} as const satisfies Readonly<Record<PricingKey, PricingEntry>>);

export type TokenCounts = Readonly<{
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
}>;

export type CostEstimate = Readonly<{
  readonly units: CostUnits;
  readonly pricingKey: PricingKey;
  readonly pricingVersion: string;
  readonly contextTokens: number;
  readonly outputTokens: number;
}>;

export type CostSettlement = Readonly<{
  readonly costUnits: CostUnits;
  readonly measuredCostUnits?: CostUnits;
  readonly usage?: TokenCounts;
  readonly usageCompleteness: "complete" | "partial" | "unknown";
  readonly adjustmentUnits: CostUnits;
}>;

export type CostJournal = NonNullable<OperationLifecycle["cost_accounting"]>;

export class CostAccountingError extends Error {
  readonly code: "estimate_unavailable" | "measurement_malformed";

  constructor(
    code: "estimate_unavailable" | "measurement_malformed",
    message: string,
    options: Readonly<{ readonly cause?: unknown }> = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CostAccountingError";
    this.code = code;
    Object.freeze(this);
  }
}

const MAX_SAFE_COST_UNITS = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_TOKEN_COUNT = 1_000_000_000;
const ESTIMATE_TOKENS_BY_EFFORT: Readonly<
  Record<
    Effort,
    Readonly<{
      readonly context: number;
      readonly output: number;
    }>
  >
> = Object.freeze({
  low: Object.freeze({ context: 32_768, output: 4_096 }),
  medium: Object.freeze({ context: 65_536, output: 8_192 }),
  high: Object.freeze({ context: 131_072, output: 16_384 }),
  xhigh: Object.freeze({ context: 272_001, output: 32_768 }),
  max: Object.freeze({ context: 1_000_000, output: 65_536 }),
});

/** Resolves an internal model alias through the Codex wire mapping and pricing registry. */
export function pricingFor(
  model: string,
  serviceTier: string,
  contextTokens: number,
): PricingEntry {
  assertBoundedInteger(contextTokens, "context token");
  const wireModel = resolveWireModel(model);
  const protocolTier = resolveProtocolTier(serviceTier);
  const contextClass = contextTokens > LONG_CONTEXT_INPUT_THRESHOLD ? "long" : "short";
  const key = `${wireModel}:${protocolTier}:${contextClass}` as PricingKey;
  const entry = PRICING_REGISTRY[key];
  if (entry === undefined) {
    throw new CostAccountingError(
      "estimate_unavailable",
      `No conservative pricing entry exists for ${key}.`,
    );
  }
  return entry;
}

/** Converts a public decimal cost input to exact bounded microcurrency units once. */
export function costMaxToUnits(value: number): CostUnits {
  if (!Number.isFinite(value) || value < 0) {
    throw new CostAccountingError("estimate_unavailable", "The hard cost limit is invalid.");
  }
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(text);
  if (match === null) {
    throw new CostAccountingError(
      "estimate_unavailable",
      "The hard cost limit must be a bounded decimal number.",
    );
  }
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  const scale = fraction.length - exponent;
  const whole = match[1];
  if (whole === undefined) {
    throw new CostAccountingError(
      "estimate_unavailable",
      "The hard cost limit must be a bounded decimal number.",
    );
  }
  const digits = BigInt(`${whole}${fraction}`);
  const unitScale = 6;
  const divisor = scale > unitScale ? 10n ** BigInt(scale - unitScale) : 1n;
  const unitsBig =
    scale > unitScale
      ? (digits + divisor - 1n) / divisor
      : digits * 10n ** BigInt(unitScale - scale);
  if (unitsBig > BigInt(MAX_SAFE_COST_UNITS)) {
    throw new CostAccountingError("estimate_unavailable", "The hard cost limit is too large.");
  }
  return Number(unitsBig);
}

/** Converts exact internal units to display currency at the telemetry boundary. */
export function costUnitsToDisplay(units: CostUnits): number {
  assertCostUnits(units, "cost units");
  return units / COST_UNIT_SCALE;
}

/** Estimates one route turn from its effort, service tier, and bounded maximum token shape. */
export function estimateRouteCost(
  input: Readonly<{
    readonly route: RouteDefinition;
    readonly serviceTier: ServiceTier;
    readonly maxContextTokens?: number;
    readonly maxOutputTokens?: number;
  }>,
): CostEstimate {
  const defaults = ESTIMATE_TOKENS_BY_EFFORT[input.route.effort];
  const contextTokens = input.maxContextTokens ?? defaults.context;
  const outputTokens = input.maxOutputTokens ?? defaults.output;
  const entry = pricingFor(input.route.model, input.serviceTier, contextTokens);
  const units = priceTokenCounts(entry, {
    input_tokens: contextTokens,
    cached_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
  });
  return Object.freeze({
    units,
    pricingKey: entry.key,
    pricingVersion: PRICING_VERSION,
    contextTokens,
    outputTokens,
  });
}

/** Estimates a conservative plan reservation across the requested turn and retry count. */
export function estimatePlanCost(
  input: Readonly<{
    readonly route: RouteDefinition;
    readonly serviceTier: ServiceTier;
    readonly calls: number;
    readonly retries?: number;
  }>,
): CostUnits {
  assertBoundedInteger(input.calls, "expected calls");
  assertBoundedInteger(input.retries ?? 0, "expected retries");
  const perTurn = estimateRouteCost({
    route: input.route,
    serviceTier: input.serviceTier,
  }).units;
  const turns = Math.max(1, input.calls) * (1 + (input.retries ?? 0));
  const units = perTurn * turns;
  if (!Number.isSafeInteger(units)) {
    throw new CostAccountingError("estimate_unavailable", "The plan cost estimate is too large.");
  }
  return units;
}

/** Prices complete usage, or conservatively retains the reservation for unavailable usage. */
export function settleUsage(usage: unknown, estimate: CostEstimate): CostSettlement {
  if (usage === undefined) {
    return conservativeSettlement(estimate, "unknown");
  }
  const normalized = normalizeUsage(usage);
  if (normalized.completeness !== "complete") {
    return conservativeSettlement(estimate, "partial", normalized.usage);
  }
  const entry = pricingFor(
    "Luna",
    estimate.pricingKey.includes(":priority:") ? "Fast" : "Standard",
    normalized.usage.input_tokens ?? 0,
  );
  const measuredCostUnits = priceTokenCounts(entry, normalized.usage);
  return Object.freeze({
    costUnits: measuredCostUnits,
    measuredCostUnits,
    usage: normalized.usage,
    usageCompleteness: "complete",
    adjustmentUnits: measuredCostUnits - estimate.units,
  });
}

export function conservativeSettlement(
  estimate: CostEstimate,
  completeness: "partial" | "unknown" = "unknown",
  usage?: TokenCounts,
): CostSettlement {
  return Object.freeze({
    costUnits: estimate.units,
    ...(usage === undefined ? {} : { usage }),
    usageCompleteness: completeness,
    adjustmentUnits: 0,
  });
}

/** Creates the prompt-free journal projection for one capacity settlement. */
export function costJournal(
  estimate: CostEstimate,
  settlement: CostSettlement | undefined,
  snapshot: CapacityLedgerSnapshot,
): CostJournal {
  return {
    estimated_units: estimate.units,
    ...(settlement?.measuredCostUnits === undefined
      ? {}
      : { measured_units: settlement.measuredCostUnits }),
    pricing_key: estimate.pricingKey,
    pricing_version: estimate.pricingVersion,
    ...(settlement?.usage === undefined ? {} : { usage: settlement.usage }),
    usage_completeness: settlement?.usageCompleteness ?? "unknown",
    adjustment_units: settlement?.adjustmentUnits ?? 0,
    committed_units: snapshot.committedCost,
    reserved_units: snapshot.reservedCost,
    overflow: snapshot.overflow,
  };
}

function resolveWireModel(model: string): string {
  try {
    return codexModelIdFor(model);
  } catch (cause) {
    throw new CostAccountingError(
      "estimate_unavailable",
      `The model alias ${model} has no conservative pricing mapping.`,
      { cause },
    );
  }
}

function resolveProtocolTier(serviceTier: string): PricingServiceTier {
  if (serviceTier !== "Standard" && serviceTier !== "Fast") {
    throw new CostAccountingError(
      "estimate_unavailable",
      `The service tier ${String(serviceTier)} has no conservative pricing mapping.`,
    );
  }
  try {
    return codexServiceTierFor(serviceTier) === "priority" ? "priority" : "standard";
  } catch (cause) {
    throw new CostAccountingError(
      "estimate_unavailable",
      `The service tier ${String(serviceTier)} has no conservative pricing mapping.`,
      { cause },
    );
  }
}

function normalizeUsage(value: unknown): Readonly<{
  readonly completeness: "complete" | "partial";
  readonly usage: TokenCounts;
}> {
  if (!isRecord(value)) {
    throw new CostAccountingError("measurement_malformed", "Provider usage is not an object.");
  }
  const object = value;
  const keys = new Set([
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ]);
  if (Object.keys(object).some((key) => !keys.has(key))) {
    throw new CostAccountingError(
      "measurement_malformed",
      "Provider usage contains unknown fields.",
    );
  }
  const read = (snake: string, camel: string): number | undefined => {
    const valueAtKey = object[snake] ?? object[camel];
    if (valueAtKey === undefined) {
      return undefined;
    }
    if (
      typeof valueAtKey !== "number" ||
      !Number.isSafeInteger(valueAtKey) ||
      valueAtKey < 0 ||
      valueAtKey > MAX_SAFE_TOKEN_COUNT
    ) {
      throw new CostAccountingError(
        "measurement_malformed",
        "Provider usage contains an invalid token count.",
      );
    }
    return valueAtKey;
  };
  const input = read("input_tokens", "inputTokens");
  const cachedInput = read("cached_input_tokens", "cachedInputTokens");
  const output = read("output_tokens", "outputTokens");
  const reasoningOutput = read("reasoning_output_tokens", "reasoningOutputTokens");
  const total = read("total_tokens", "totalTokens");
  const usage: TokenCounts = {
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(cachedInput === undefined ? {} : { cached_input_tokens: cachedInput }),
    ...(output === undefined ? {} : { output_tokens: output }),
    ...(reasoningOutput === undefined ? {} : { reasoning_output_tokens: reasoningOutput }),
    ...(total === undefined ? {} : { total_tokens: total }),
  };
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.cached_input_tokens;
  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cachedInputTokens > inputTokens
  ) {
    throw new CostAccountingError(
      "measurement_malformed",
      "Cached input exceeds total input usage.",
    );
  }
  const complete =
    usage.input_tokens !== undefined &&
    usage.cached_input_tokens !== undefined &&
    usage.output_tokens !== undefined &&
    usage.reasoning_output_tokens !== undefined;
  return { completeness: complete ? "complete" : "partial", usage };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function priceTokenCounts(entry: PricingEntry, usage: TokenCounts): CostUnits {
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const reasoning = usage.reasoning_output_tokens ?? 0;
  const uncached = input - cached;
  const outputIncludingReasoning = output + reasoning;
  if (uncached < 0 || !Number.isSafeInteger(outputIncludingReasoning)) {
    throw new CostAccountingError("measurement_malformed", "Token usage cannot be priced safely.");
  }
  const units =
    ceilMillion(uncached, entry.rate.uncachedInputPerMillion) +
    ceilMillion(cached, entry.rate.cachedInputPerMillion) +
    ceilMillion(outputIncludingReasoning, entry.rate.outputPerMillion);
  if (!Number.isSafeInteger(units) || units > MAX_SAFE_COST_UNITS) {
    throw new CostAccountingError(
      "measurement_malformed",
      "The token-equivalent cost is too large.",
    );
  }
  return units;
}

function ceilMillion(tokens: number, rate: number): number {
  const product = tokens * rate;
  if (!Number.isSafeInteger(product)) {
    throw new CostAccountingError(
      "measurement_malformed",
      "Token-equivalent multiplication overflowed.",
    );
  }
  return Math.floor((product + COST_UNIT_SCALE - 1) / COST_UNIT_SCALE);
}

function assertBoundedInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CostAccountingError("estimate_unavailable", `The ${label} value is invalid.`);
  }
}

function assertCostUnits(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_COST_UNITS) {
    throw new CostAccountingError("estimate_unavailable", `The ${label} value is invalid.`);
  }
}

export type CompleteExecutionUsage = ExecutionUsage;
