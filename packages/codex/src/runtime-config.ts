// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonUtf8, domainSeparatedSha256, type Sha256Digest } from "@holycodex/core";
import { NATIVE_AGENT_TYPES, type Effort, type NativeAgentType } from "@holycodex/core";
import * as Schema from "effect/Schema";

import { isPlainObject, invalidData } from "./common";

/**
 * A parsed TOML value. Parsing and serialization stay with the Codex boundary; this package only
 * manipulates validated values and never implements a TOML parser.
 */
export type TomlValue = string | number | boolean | null | readonly TomlValue[] | TomlTable;
export interface TomlTable {
  readonly [key: string]: TomlValue;
}
export type TomlDocument = TomlTable;

function isTomlValue(value: unknown, seen = new Set<object>()): value is TomlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => isTomlValue(item, seen));
    return isPlainObject(value) && Object.values(value).every((item) => isTomlValue(item, seen));
  } finally {
    seen.delete(value);
  }
}

function isTomlTable(value: unknown): value is TomlTable {
  return isPlainObject(value) && isTomlValue(value);
}

export const TomlValueSchema = Schema.declare((value: unknown): value is TomlValue =>
  isTomlValue(value),
);
export const TomlDocumentSchema = Schema.declare((value: unknown): value is TomlDocument =>
  isTomlTable(value),
);

function pathParts(keyPath: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index <= keyPath.length; index += 1) {
    const character = keyPath[index];
    if (index === keyPath.length || (character === "." && !quoted)) {
      const raw = keyPath.slice(start, index);
      const part = raw.startsWith('"') ? parseQuotedKeyPart(raw) : raw;
      if (
        !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(part) &&
        !NATIVE_AGENT_TYPES.includes(part as NativeAgentType)
      ) {
        throw invalidData("TOML key path", keyPath);
      }
      parts.push(part);
      start = index + 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
    }
  }
  if (quoted || escaped || parts.length === 0) throw invalidData("TOML key path", keyPath);
  if (
    parts.some((part) => part === "__proto__" || part === "constructor" || part === "prototype")
  ) {
    throw invalidData("TOML key path", keyPath);
  }
  return parts;
}

function parseQuotedKeyPart(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
  } catch {
    // The caller reports the complete invalid key path.
  }
  throw invalidData("TOML quoted key", value);
}

/** Read a dotted key from a parsed TOML document without exposing raw state. */
export function readTomlPath(document: TomlDocument, keyPath: string): TomlValue | undefined {
  if (!isTomlTable(document)) throw invalidData("TOML document", document);
  let current: TomlValue = document;
  for (const part of pathParts(keyPath)) {
    if (!isTomlTable(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part]!;
  }
  return current;
}

function cloneTomlValue(value: TomlValue): TomlValue {
  if (Array.isArray(value)) return value.map(cloneTomlValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneTomlValue(item)]),
    );
  }
  return value;
}

function cloneTomlTable(value: TomlTable): TomlTable {
  return cloneTomlValue(value) as TomlTable;
}

/** Set one dotted key while retaining every unrelated parsed TOML value. */
export function writeTomlPath(
  document: TomlDocument,
  keyPath: string,
  value: TomlValue,
): TomlDocument {
  if (!isTomlTable(document) || !isTomlValue(value)) {
    throw invalidData("TOML write", { keyPath });
  }
  const parts = pathParts(keyPath);
  const output: Record<string, TomlValue> = { ...cloneTomlTable(document) };
  let current = output;
  for (const part of parts.slice(0, -1)) {
    const nested = current[part];
    if (nested !== undefined && !isTomlTable(nested)) {
      throw invalidData("TOML table path", keyPath);
    }
    const next: Record<string, TomlValue> = nested === undefined ? {} : { ...nested };
    current[part] = next;
    current = next;
  }
  current[parts.at(-1)!] = cloneTomlValue(value);
  return output;
}

/** Delete one dotted key, pruning only tables made empty by this deletion. */
export function deleteTomlPath(document: TomlDocument, keyPath: string): TomlDocument {
  if (!isTomlTable(document)) throw invalidData("TOML document", document);
  const parts = pathParts(keyPath);
  const output: Record<string, TomlValue> = { ...cloneTomlTable(document) };
  const parents: Array<{ readonly table: Record<string, TomlValue>; readonly key: string }> = [];
  let current: Record<string, TomlValue> = output;
  for (const part of parts.slice(0, -1)) {
    const nested = current[part];
    if (!isTomlTable(nested)) return output;
    const next: Record<string, TomlValue> = { ...nested };
    parents.push({ table: current, key: part });
    current[part] = next;
    current = next;
  }
  const leaf = parts.at(-1)!;
  if (!Object.prototype.hasOwnProperty.call(current, leaf)) return output;
  delete current[leaf];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const parent = parents[index]!;
    const nested = parent.table[parent.key];
    if (isTomlTable(nested) && Object.keys(nested).length === 0) delete parent.table[parent.key];
    else break;
  }
  return output;
}

export const ROOT_CONFIG_KEY_PATHS = [
  "model",
  "model_reasoning_effort",
  "service_tier",
  "model_verbosity",
  "developer_instructions",
  "suppress_unstable_features_warning",
  "features.default_mode_request_user_input",
  "features.multi_agent_v2",
  "features.context_management.experimental_mode",
] as const;
export type RootConfigKeyPath = (typeof ROOT_CONFIG_KEY_PATHS)[number];

export const HOLYCODEX_AGENT_TYPES = NATIVE_AGENT_TYPES;
export type HolyCodexAgentType = NativeAgentType;
export type AgentConfigKeyPath = `agents."${HolyCodexAgentType}".config_file`;
type LegacyAgentConfigKeyPath =
  | "agents.explorer.config_file"
  | "agents.librarian.config_file"
  | "agents.worker.config_file"
  | "agents.reviewer.config_file";
export type ManagedConfigKeyPath =
  | RootConfigKeyPath
  | AgentConfigKeyPath
  | LegacyAgentConfigKeyPath;

export type ManagedConfigStateKeyPath = ManagedConfigKeyPath;

export const ManagedConfigKeyPathSchema = Schema.declare(
  (value: unknown): value is ManagedConfigKeyPath => isManagedConfigKeyPath(value),
);

export function isManagedConfigKeyPath(value: unknown): value is ManagedConfigKeyPath {
  if (typeof value !== "string") return false;
  if ((ROOT_CONFIG_KEY_PATHS as readonly string[]).includes(value)) return true;
  if (/^agents\.(?:explorer|librarian|worker|reviewer)\.config_file$/u.test(value)) return true;
  return NATIVE_AGENT_TYPES.some((agentType) => value === `agents."${agentType}".config_file`);
}

function isManagedConfigStateKeyPath(value: unknown): value is ManagedConfigStateKeyPath {
  return isManagedConfigKeyPath(value);
}

type ManagedEnum =
  | "gpt-6-astra"
  | "gpt-5.6-terra"
  | "gpt-5.6-sol"
  | "gpt-5.6-luna"
  | Effort
  | "default"
  | "fast"
  | "low"
  | "medium"
  | "high";

export type ManagedConfigSafeValue =
  | { readonly kind: "enum"; readonly value: ManagedEnum }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "relative_path"; readonly value: string }
  | { readonly kind: "digest"; readonly value: Sha256Digest };
export type ManagedConfigOriginalValue = ManagedConfigSafeValue | { readonly kind: "absent" };

export const ManagedConfigSafeValueSchema = Schema.declare(
  (value: unknown): value is ManagedConfigSafeValue => isManagedConfigSafeValue(value),
);
export const ManagedConfigOriginalValueSchema = Schema.declare(
  (value: unknown): value is ManagedConfigOriginalValue => isManagedConfigOriginalValue(value),
);

export interface ManagedRuntimeConfigEntry {
  readonly owner: "holycodex";
  readonly schema: string;
  readonly installId: string;
  readonly keyPath: ManagedConfigStateKeyPath;
  readonly originalValue: ManagedConfigOriginalValue;
  readonly lastManagedValue: ManagedConfigSafeValue;
}

export interface ManagedRuntimeConfigState {
  readonly owner: "holycodex";
  readonly schema: string;
  readonly installId: string;
  readonly managed: Readonly<Record<string, ManagedRuntimeConfigEntry>>;
}

export const ManagedRuntimeConfigEntrySchema = Schema.declare(
  (value: unknown): value is ManagedRuntimeConfigEntry => isManagedRuntimeConfigEntry(value),
);
export const ManagedRuntimeConfigStateSchema = Schema.declare(
  (value: unknown): value is ManagedRuntimeConfigState => isManagedRuntimeConfigState(value),
);

export type ManagedConfigWriteValue = string | boolean;

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isSafeMetadataText(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

function isManagedEnum(value: unknown): value is ManagedEnum {
  return (
    value === "gpt-6-astra" ||
    value === "gpt-5.6-terra" ||
    value === "gpt-5.6-sol" ||
    value === "gpt-5.6-luna" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "default" ||
    value === "fast"
  );
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isManagedConfigSafeValue(value: unknown): value is ManagedConfigSafeValue {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["kind", "value"]) ||
    typeof value["kind"] !== "string"
  ) {
    return false;
  }
  switch (value["kind"]) {
    case "enum":
      return isManagedEnum(value["value"]);
    case "boolean":
      return typeof value["value"] === "boolean";
    case "relative_path":
      return typeof value["value"] === "string" && isRelativeConfigPath(value["value"]);
    case "digest":
      return isDigest(value["value"]);
    default:
      return false;
  }
}

function isSafeValueForKey(
  keyPath: ManagedConfigStateKeyPath,
  value: ManagedConfigSafeValue,
): boolean {
  switch (configKeyKind(keyPath)) {
    case "boolean":
      return value.kind === "boolean";
    case "relative_path":
      return value.kind === "relative_path";
    case "digest":
      return value.kind === "digest";
    case "enum":
      if (value.kind !== "enum") return false;
      if (keyPath === "model") {
        return (
          value.value === "gpt-6-astra" ||
          value.value === "gpt-5.6-terra" ||
          value.value === "gpt-5.6-sol" ||
          value.value === "gpt-5.6-luna"
        );
      }
      if (keyPath === "model_reasoning_effort") {
        return (
          value.value === "low" ||
          value.value === "medium" ||
          value.value === "high" ||
          value.value === "xhigh" ||
          value.value === "max"
        );
      }
      if (keyPath === "service_tier") {
        return value.value === "default" || value.value === "fast";
      }
      return value.value === "low" || value.value === "medium" || value.value === "high";
  }
}

function isManagedConfigOriginalValue(value: unknown): value is ManagedConfigOriginalValue {
  return isPlainObject(value) && value["kind"] === "absent"
    ? Object.keys(value).length === 1
    : isManagedConfigSafeValue(value);
}

function isManagedRuntimeConfigEntry(value: unknown): value is ManagedRuntimeConfigEntry {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, [
      "owner",
      "schema",
      "installId",
      "keyPath",
      "originalValue",
      "lastManagedValue",
    ]) &&
    value["owner"] === "holycodex" &&
    typeof value["schema"] === "string" &&
    isSafeMetadataText(value["schema"]) &&
    isSafeMetadataText(value["installId"]) &&
    isManagedConfigStateKeyPath(value["keyPath"]) &&
    isManagedConfigOriginalValue(value["originalValue"]) &&
    isManagedConfigSafeValue(value["lastManagedValue"]) &&
    isSafeValueForKey(value["keyPath"], value["lastManagedValue"]) &&
    (value["originalValue"]["kind"] === "absent" ||
      isSafeValueForKey(value["keyPath"], value["originalValue"]))
  );
}

export function isManagedRuntimeConfigState(value: unknown): value is ManagedRuntimeConfigState {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["owner", "schema", "installId", "managed"]) ||
    value["owner"] !== "holycodex" ||
    !isSafeMetadataText(value["schema"]) ||
    !isSafeMetadataText(value["installId"]) ||
    !isPlainObject(value["managed"])
  ) {
    return false;
  }
  return Object.entries(value["managed"]).every(
    ([key, entry]) =>
      isManagedConfigStateKeyPath(key) &&
      isManagedRuntimeConfigEntry(entry) &&
      entry.keyPath === key,
  );
}

export function createManagedRuntimeConfigState(
  metadata: Readonly<{ readonly schema: string; readonly installId: string }>,
): ManagedRuntimeConfigState {
  if (!isSafeMetadataText(metadata.schema) || !isSafeMetadataText(metadata.installId)) {
    throw invalidData("managed runtime config metadata", { schema: metadata.schema });
  }
  return {
    owner: "holycodex",
    schema: metadata.schema,
    installId: metadata.installId,
    managed: {},
  };
}

function isRelativeConfigPath(value: string): boolean {
  if (value.length === 0 || value.includes("\u0000") || /^[\\/]|^[A-Za-z]:[\\/]/u.test(value)) {
    return false;
  }
  const segments = value.replaceAll("\\", "/").split("/");
  return (
    segments.some((segment) => segment !== ".") &&
    segments.every((segment) => segment.length > 0 && segment !== "..")
  );
}

export function normalizeRelativeConfigPath(value: string): string {
  if (!isRelativeConfigPath(value)) throw invalidData("relative config path", "[redacted]");
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
}

/** Resolve an agent config_file using the declaring config file as its base. */
export function resolveAgentConfigPath(declaringConfigPath: string, configFile: string): string {
  const normalized = normalizeRelativeConfigPath(configFile);
  const base = declaringConfigPath.replaceAll("\\", "/").split("/");
  base.pop();
  const joined = [...base, ...normalized.split("/")].join("/");
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const declaringNormalized = declaringConfigPath.replaceAll("\\", "/");
  const prefix = declaringNormalized.startsWith("//")
    ? "//"
    : declaringNormalized.startsWith("/")
      ? "/"
      : "";
  return `${prefix}${segments.join("/")}`;
}

function configKeyKind(
  keyPath: ManagedConfigStateKeyPath,
): "enum" | "boolean" | "relative_path" | "digest" {
  if (keyPath === "developer_instructions") return "digest";
  if (keyPath.endsWith(".config_file")) return "relative_path";
  if (
    keyPath === "suppress_unstable_features_warning" ||
    keyPath === "features.default_mode_request_user_input" ||
    keyPath === "features.multi_agent_v2" ||
    keyPath === "features.context_management.experimental_mode"
  ) {
    return "boolean";
  }
  return "enum";
}

function isExpectedValueForKey(keyPath: ManagedConfigKeyPath, value: TomlValue): boolean {
  const kind = configKeyKind(keyPath);
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "relative_path") return typeof value === "string" && isRelativeConfigPath(value);
  if (kind === "digest") return typeof value === "string";
  return typeof value === "string" && isManagedEnum(value);
}

/** Convert one live TOML value into the only representation allowed in state. */
export async function summarizeManagedConfigValue(
  keyPath: ManagedConfigStateKeyPath,
  value: TomlValue,
): Promise<ManagedConfigSafeValue> {
  if (!isManagedConfigStateKeyPath(keyPath) || !isTomlValue(value)) {
    throw invalidData("managed config value", { keyPath });
  }
  const kind = configKeyKind(keyPath);
  if (kind === "boolean" && typeof value === "boolean") return { kind, value };
  if (kind === "relative_path" && typeof value === "string" && isRelativeConfigPath(value)) {
    return { kind, value: normalizeRelativeConfigPath(value) };
  }
  if (kind === "enum" && typeof value === "string" && isManagedEnum(value)) {
    return { kind, value };
  }
  return {
    kind: "digest",
    value: await domainSeparatedSha256("holycodex-managed-config-value", [
      canonicalJsonUtf8({ keyPath, value }),
    ]),
  };
}

function safeValueToToml(value: ManagedConfigSafeValue): string | boolean | undefined {
  if (value.kind === "enum" || value.kind === "boolean" || value.kind === "relative_path") {
    return value.value;
  }
  return undefined;
}

export interface ManagedRuntimeConfigMerge {
  readonly document: TomlDocument;
  readonly state: ManagedRuntimeConfigState;
  readonly driftedKeys: readonly ManagedConfigKeyPath[];
}

/**
 * Merge only managed keys into a parsed document. Existing managed keys are compared individually;
 * a changed value is preserved and reported as drift.
 */
export async function mergeManagedRuntimeConfig(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>,
  metadata: Readonly<{ readonly schema: string; readonly installId: string }>,
): Promise<ManagedRuntimeConfigMerge> {
  if (
    !isTomlTable(document) ||
    !isManagedRuntimeConfigState(current) ||
    !isSafeMetadataText(metadata.schema) ||
    !isSafeMetadataText(metadata.installId)
  ) {
    throw invalidData("managed runtime config", {});
  }
  const outputEntries: Record<string, ManagedRuntimeConfigEntry> = { ...current.managed };
  let output = cloneTomlTable(document);
  const driftedKeys: ManagedConfigKeyPath[] = [];
  for (const [rawKeyPath, nextValue] of Object.entries(desired)) {
    if (
      !isManagedConfigKeyPath(rawKeyPath) ||
      (typeof nextValue !== "string" && typeof nextValue !== "boolean")
    ) {
      throw invalidData("managed config key", rawKeyPath);
    }
    const keyPath = rawKeyPath;
    const existing = current.managed[keyPath];
    const live = readTomlPath(output, keyPath);
    if (
      existing &&
      (existing.schema !== metadata.schema || existing.installId !== metadata.installId)
    ) {
      driftedKeys.push(keyPath);
      continue;
    }
    if (existing && existing.owner === "holycodex") {
      const liveSummary =
        live === undefined ? undefined : await summarizeManagedConfigValue(keyPath, live);
      if (
        liveSummary === undefined ||
        JSON.stringify(liveSummary) !== JSON.stringify(existing.lastManagedValue)
      ) {
        driftedKeys.push(keyPath);
        continue;
      }
    }
    const originalValue: ManagedConfigOriginalValue =
      existing?.originalValue ??
      (live === undefined ? { kind: "absent" } : await summarizeManagedConfigValue(keyPath, live));
    if (!isExpectedValueForKey(keyPath, nextValue)) {
      throw invalidData("managed config value", { keyPath });
    }
    output = writeTomlPath(output, keyPath, nextValue);
    outputEntries[keyPath] = {
      owner: "holycodex",
      schema: metadata.schema,
      installId: metadata.installId,
      keyPath,
      originalValue,
      lastManagedValue: await summarizeManagedConfigValue(keyPath, nextValue),
    };
  }
  const state: ManagedRuntimeConfigState = {
    owner: "holycodex",
    schema: metadata.schema,
    installId: metadata.installId,
    managed: outputEntries,
  };
  if (!isManagedRuntimeConfigState(state)) throw invalidData("managed runtime config state", {});
  return { document: output, state, driftedKeys };
}

export interface ManagedRuntimeConfigCleanup {
  readonly document: TomlDocument;
  readonly state: ManagedRuntimeConfigState;
  readonly restoredKeys: readonly ManagedConfigStateKeyPath[];
  readonly preservedKeys: readonly ManagedConfigStateKeyPath[];
  readonly unresolvedKeys: readonly ManagedConfigStateKeyPath[];
}

/** Restore only unchanged values owned by the current HolyCodex installation. */
export async function cleanupManagedRuntimeConfig(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  metadata: Readonly<{ readonly schema: string; readonly installId: string }>,
): Promise<ManagedRuntimeConfigCleanup> {
  if (!isTomlTable(document) || !isManagedRuntimeConfigState(current)) {
    throw invalidData("managed runtime config", {});
  }
  let output = cloneTomlTable(document);
  const remaining: Record<string, ManagedRuntimeConfigEntry> = { ...current.managed };
  const restoredKeys: ManagedConfigStateKeyPath[] = [];
  const preservedKeys: ManagedConfigStateKeyPath[] = [];
  const unresolvedKeys: ManagedConfigStateKeyPath[] = [];
  for (const [rawKeyPath, entry] of Object.entries(current.managed)) {
    if (!isManagedConfigStateKeyPath(rawKeyPath)) {
      throw invalidData("managed config key", rawKeyPath);
    }
    const keyPath = rawKeyPath;
    if (
      entry.owner !== "holycodex" ||
      entry.schema !== metadata.schema ||
      entry.installId !== metadata.installId
    ) {
      if (entry.schema !== metadata.schema || entry.installId !== metadata.installId) {
        unresolvedKeys.push(keyPath);
      }
      continue;
    }
    const live = readTomlPath(output, keyPath);
    const unchanged =
      live !== undefined &&
      JSON.stringify(await summarizeManagedConfigValue(keyPath, live)) ===
        JSON.stringify(entry.lastManagedValue);
    if (!unchanged) {
      preservedKeys.push(keyPath);
      continue;
    }
    if (entry.originalValue.kind === "absent") {
      output = deleteTomlPath(output, keyPath);
      restoredKeys.push(keyPath);
      delete remaining[keyPath];
    } else {
      const original = safeValueToToml(entry.originalValue);
      if (original === undefined) {
        unresolvedKeys.push(keyPath);
        preservedKeys.push(keyPath);
        continue;
      }
      output = writeTomlPath(output, keyPath, original);
      restoredKeys.push(keyPath);
      delete remaining[keyPath];
    }
  }
  return {
    document: output,
    state: { ...current, managed: remaining },
    restoredKeys,
    preservedKeys,
    unresolvedKeys,
  };
}

export interface ManagedConfigDrift {
  readonly keyPath: ManagedConfigKeyPath;
  readonly status: "unmanaged" | "unchanged" | "drifted";
  readonly current?: ManagedConfigSafeValue;
  readonly expected?: ManagedConfigSafeValue;
}

/** Readback comparison that returns only safe summaries, never raw values. */
export async function compareManagedConfigKey(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  keyPath: ManagedConfigKeyPath,
): Promise<ManagedConfigDrift> {
  if (!isManagedConfigKeyPath(keyPath) || !isManagedRuntimeConfigState(current)) {
    throw invalidData("managed config key", keyPath);
  }
  const entry = current.managed[keyPath];
  const live = readTomlPath(document, keyPath);
  const summary = live === undefined ? undefined : await summarizeManagedConfigValue(keyPath, live);
  if (!entry) {
    return summary === undefined
      ? { keyPath, status: "unmanaged" }
      : { keyPath, status: "unmanaged", current: summary };
  }
  return {
    keyPath,
    status:
      summary !== undefined && JSON.stringify(summary) === JSON.stringify(entry.lastManagedValue)
        ? "unchanged"
        : "drifted",
    expected: entry.lastManagedValue,
    ...(summary === undefined ? {} : { current: summary }),
  };
}

export function assertManagedRuntimeConfigState(value: unknown): ManagedRuntimeConfigState {
  if (!isManagedRuntimeConfigState(value)) throw invalidData("managed runtime config state", {});
  return value;
}
