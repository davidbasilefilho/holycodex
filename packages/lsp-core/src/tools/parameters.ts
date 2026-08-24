// SPDX-License-Identifier: Apache-2.0

import type { SeverityFilter } from "../lsp/types.ts";
import { isRecord } from "../lsp/schema.ts";

export interface SourcePosition {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
}
export function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Missing required string parameter '${key}'`);
  return value;
}
export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}
export function requireNumber(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Missing required number parameter '${key}'`);
  return value;
}
export function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}
export function sourcePosition(params: Record<string, unknown>): SourcePosition {
  return {
    filePath: requireString(params, "filePath"),
    line: requireNumber(params, "line"),
    character: requireNumber(params, "character"),
  };
}
export function severityFilter(params: Record<string, unknown>): SeverityFilter {
  const value = params["severity"];
  return value === "error" ||
    value === "warning" ||
    value === "information" ||
    value === "hint" ||
    value === "all"
    ? value
    : "all";
}
export function coerceToolArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
