import { UnknownRecordSchema } from "@holycodex/mcp-stdio-core/schemas";
import { z } from "zod";

import type { WithLspClientOptions } from "../lsp/client-wrapper.js";
import type { SeverityFilter } from "../lsp/types.js";

const NonEmptyStringSchema = z.string().min(1);
const FiniteNumberSchema = z.number().finite();
const SeverityFilterSchema = z.enum(["error", "warning", "information", "hint", "all"]);

/** Checks whether a value is a JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return UnknownRecordSchema.safeParse(value).success;
}

export interface SourcePosition {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
}

/** Provides source position. */
export function sourcePosition(params: Record<string, unknown>): SourcePosition {
  return {
    filePath: requireString(params, "filePath"),
    line: requireNumber(params, "line"),
    character: requireNumber(params, "character"),
  };
}

/** Reads and validates string. */
export function requireString(params: Record<string, unknown>, key: string): string {
  const parsed = NonEmptyStringSchema.safeParse(params[key]);
  if (!parsed.success) {
    throw new Error(`Missing required string parameter '${key}'`);
  }
  return parsed.data;
}

/** Reads optional string. */
export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  return z.string().safeParse(params[key]).data;
}

/** Reads and validates number. */
export function requireNumber(params: Record<string, unknown>, key: string): number {
  const parsed = FiniteNumberSchema.safeParse(params[key]);
  if (!parsed.success) {
    throw new Error(`Missing required number parameter '${key}'`);
  }
  return parsed.data;
}

/** Reads optional number. */
export function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  return FiniteNumberSchema.safeParse(params[key]).data;
}

/** Reads optional boolean. */
export function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  return z.boolean().safeParse(params[key]).data;
}

/** Provides severity filter. */
export function severityFilter(params: Record<string, unknown>): SeverityFilter {
  return SeverityFilterSchema.safeParse(params["severity"]).data ?? "all";
}

/** Provides client options. */
export function clientOptions(signal: AbortSignal | undefined): WithLspClientOptions {
  return signal === undefined ? {} : { signal };
}
