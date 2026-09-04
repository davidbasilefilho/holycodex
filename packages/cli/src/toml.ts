// SPDX-License-Identifier: Apache-2.0

import type { TomlDocument, TomlTable, TomlValue } from "@holycodex/codex";

/**
 * Small TOML 1.0 subset used only when the CLI is exercised outside Bun. Production uses Bun.TOML;
 * this fallback keeps the validated config boundary available to the Node-based test runner without
 * storing raw TOML in state.
 */
export function parseToml(text: string): TomlDocument {
  const document: Record<string, TomlValue> = {};
  let table: string[] = [];
  for (const sourceLine of text.split(/\r?\n/u)) {
    const line = stripComment(sourceLine).trim();
    if (line.length === 0) continue;
    if (line.startsWith("[[") || line.endsWith("]]")) {
      throw new Error("Array-of-tables are not supported by the validated fallback.");
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      table = parseKey(line.slice(1, -1).trim());
      ensurePath(document, table);
      continue;
    }
    const equals = findAssignment(line);
    if (equals < 1) throw new Error("TOML assignment is invalid.");
    const key = parseKey(line.slice(0, equals).trim());
    const value = parseValue(line.slice(equals + 1).trim());
    setPath(document, [...table, ...key], value);
  }
  return document;
}

export function stringifyToml(document: TomlDocument): string {
  const lines: string[] = [];
  writeTable(document, [], lines);
  return lines.join("\n");
}

function writeTable(table: TomlTable, prefix: readonly string[], lines: string[]): void {
  const scalarEntries: Array<[string, TomlValue]> = [];
  const tableEntries: Array<[string, TomlTable]> = [];
  for (const [key, value] of Object.entries(table)) {
    if (isTable(value)) tableEntries.push([key, value]);
    else scalarEntries.push([key, value]);
  }
  if (prefix.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`[${prefix.map(formatKey).join(".")}]`);
  }
  for (const [key, value] of scalarEntries) {
    lines.push(`${formatKey(key)} = ${formatValue(value)}`);
  }
  for (const [key, value] of tableEntries) writeTable(value, [...prefix, key], lines);
}

function parseValue(source: string): TomlValue {
  if (source.length === 0) throw new Error("TOML value is missing.");
  if (source.startsWith('"')) {
    const value = JSON.parse(source) as unknown;
    if (typeof value !== "string") throw new Error("TOML string is invalid.");
    return value;
  }
  if (source.startsWith("'")) {
    if (!source.endsWith("'") || source.length < 2) throw new Error("TOML string is invalid.");
    return source.slice(1, -1);
  }
  if (source === "true") return true;
  if (source === "false") return false;
  if (source.startsWith("[")) {
    if (!source.endsWith("]")) throw new Error("TOML array is invalid.");
    const inner = source.slice(1, -1).trim();
    return inner.length === 0 ? [] : splitTopLevel(inner, ",").map(parseValue);
  }
  if (source.startsWith("{")) {
    if (!source.endsWith("}")) throw new Error("TOML inline table is invalid.");
    const inner = source.slice(1, -1).trim();
    const output: Record<string, TomlValue> = {};
    if (inner.length === 0) return output;
    for (const item of splitTopLevel(inner, ",")) {
      const equals = findAssignment(item);
      if (equals < 1) throw new Error("TOML inline table entry is invalid.");
      setPath(
        output,
        parseKey(item.slice(0, equals).trim()),
        parseValue(item.slice(equals + 1).trim()),
      );
    }
    return output;
  }
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(source)) {
    const value = Number(source);
    if (Number.isFinite(value)) return value;
  }
  throw new Error("TOML value is unsupported.");
}

function parseKey(source: string): string[] {
  const parts = splitTopLevel(source, ".").map((part) => part.trim());
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        !/^(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')$/u.test(part) ||
        part === "__proto__" ||
        part === "constructor" ||
        part === "prototype",
    )
  ) {
    throw new Error("TOML key is invalid.");
  }
  return parts.map((part) =>
    part.startsWith('"') || part.startsWith("'") ? (parseValue(part) as string) : part,
  );
}

function setPath(root: Record<string, TomlValue>, path: readonly string[], value: TomlValue): void {
  if (path.length === 0) throw new Error("TOML key is missing.");
  let current = root;
  for (const part of path.slice(0, -1)) {
    const existing = current[part];
    if (existing === undefined) {
      const next: Record<string, TomlValue> = {};
      current[part] = next;
      current = next;
    } else if (isTable(existing)) {
      current = existing as Record<string, TomlValue>;
    } else {
      throw new Error("TOML key conflicts with a scalar.");
    }
  }
  const leaf = path.at(-1)!;
  if (Object.prototype.hasOwnProperty.call(current, leaf)) {
    throw new Error("TOML key is duplicated.");
  }
  current[leaf] = value;
}

function ensurePath(root: Record<string, TomlValue>, path: readonly string[]): void {
  let current = root;
  for (const part of path) {
    const existing = current[part];
    if (existing === undefined) {
      const next: Record<string, TomlValue> = {};
      current[part] = next;
      current = next;
    } else if (isTable(existing)) {
      current = existing as Record<string, TomlValue>;
    } else {
      throw new Error("TOML table conflicts with a scalar.");
    }
  }
}

function splitTopLevel(source: string, delimiter: string): string[] {
  const output: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === delimiter && depth === 0) {
      output.push(source.slice(start, index));
      start = index + 1;
    }
  }
  if (quote !== undefined || depth !== 0) throw new Error("TOML value is unbalanced.");
  output.push(source.slice(start));
  return output;
}

function findAssignment(source: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "=" && depth === 0) return index;
  }
  return -1;
}

function stripComment(source: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return source.slice(0, index);
  }
  return source;
}

function isTable(value: TomlValue): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
}

function formatValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("TOML number is invalid.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (value === null) throw new Error("TOML null is not serializable.");
  throw new Error("TOML nested values must be tables.");
}
