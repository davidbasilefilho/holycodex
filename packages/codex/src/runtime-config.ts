// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonUtf8, domainSeparatedSha256, type Sha256Digest } from "@holycodex/core";
import { NATIVE_AGENT_TYPES, type Effort, type NativeAgentType } from "@holycodex/core";

// Retired registrations remain parseable for owned-state cleanup and restoration.
const PERSISTED_NATIVE_AGENT_TYPES: readonly string[] = [...NATIVE_AGENT_TYPES, "Reviewer.plan"];
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { CodexError, isPlainObject, invalidData } from "./common";
import { OfficialPluginIdSchema } from "./official-plugins";

/**
 * A parsed TOML value. Parsing and serialization stay with the Codex boundary; this package only
 * manipulates validated values and never implements a TOML parser.
 */
export type TomlValue = string | number | boolean | null | readonly TomlValue[] | TomlTable;
/** TOML table whose values use the managed configuration value model. */
export interface TomlTable {
  /** <computed> in the toml table contract. */
  readonly [key: string]: TomlValue;
}
/** Parsed TOML document represented as a root table. */
export type TomlDocument = TomlTable;

/** Validates toml value values at the Codex boundary. */
export const TomlValueSchema: Schema.Codec<TomlValue, unknown> = Schema.Json;
/** Validates toml document values at the Codex boundary. */
export const TomlDocumentSchema: Schema.Codec<TomlDocument, unknown> = Schema.JsonObject;

function isTomlValue(value: unknown): value is TomlValue {
  return Schema.is(TomlValueSchema)(value);
}

function isTomlTable(value: unknown): value is TomlTable {
  return Schema.is(TomlDocumentSchema)(value);
}

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
      const quotedPart = raw.startsWith('"');
      const quotedPluginId =
        quotedPart &&
        parts.length === 1 &&
        parts[0] === "plugins" &&
        Schema.is(OfficialPluginIdSchema)(part);
      const quotedNativeAgent =
        quotedPart &&
        parts.length === 1 &&
        parts[0] === "agents" &&
        PERSISTED_NATIVE_AGENT_TYPES.includes(part);
      if (
        quotedPart
          ? !quotedPluginId && !quotedNativeAgent
          : !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(part) && !PERSISTED_NATIVE_AGENT_TYPES.includes(part)
      ) {
        throw invalidData("TOML key path", keyPath);
      }
      if (
        part === "__proto__" ||
        ((part === "constructor" || part === "prototype") && !quotedPluginId)
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
  return parts;
}

function parseQuotedKeyPart(value: string): string {
  const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.String))(value);
  if (Result.isSuccess(parsed)) return parsed.success;
  throw invalidData("TOML quoted key", value);
}

/** Read a dotted key from a parsed TOML document without exposing raw state. */
export function readTomlPath(document: TomlDocument, keyPath: string): TomlValue | undefined {
  if (!isTomlTable(document)) throw invalidData("TOML document", document);
  let current: TomlValue = document;
  const parts = pathParts(keyPath);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!isTomlTable(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part]!;
    if (index === 1 && parts[0] === "features" && typeof current === "boolean") {
      if (part === "context_management" && parts[2] === "experimental_mode") return current;
      if (part === "multi_agent_v2" && parts[2] === "enabled") return current;
    }
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
    const nested = Object.prototype.hasOwnProperty.call(current, part) ? current[part] : undefined;
    if (nested !== undefined && !isTomlTable(nested)) {
      if (
        typeof nested !== "boolean" ||
        current !== output["features"] ||
        !["context_management", "multi_agent_v2"].includes(part)
      ) {
        throw invalidData("TOML table path", keyPath);
      }
      if (
        ((part === "context_management" && parts.at(-1) === "experimental_mode") ||
          (part === "multi_agent_v2" && parts.at(-1) === "enabled")) &&
        nested === value
      )
        return output;
      current[part] =
        part === "context_management" ? { experimental_mode: nested } : { enabled: nested };
    }
    const next: Record<string, TomlValue> =
      nested === undefined
        ? {}
        : isTomlTable(current[part])
          ? { ...(current[part] as TomlTable) }
          : {};
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

/** Canonical root config key paths used by the Codex integration. */
export const ROOT_CONFIG_KEY_PATHS = [
  "model",
  "model_catalog_json",
  "model_reasoning_effort",
  "service_tier",
  "agents.enabled",
  "agents.default.config_file",
  "agents.worker.config_file",
  "agents.explorer.config_file",
  "agents.librarian.config_file",
  "agents.reviewer.config_file",
  "agents.max_concurrent_threads_per_session",
  "agents.max_depth",
  "web_search",
  "approval_policy",
  "approvals_reviewer",
  "default_permissions",
  "model_verbosity",
  "developer_instructions",
  "include_collaboration_mode_instructions",
  "tools.experimental_request_user_input.enabled",
  "tools.update_plan.enabled",
  "suppress_unstable_features_warning",
  "features.multi_agent",
  "features.default_mode_request_user_input",
  "features.goals",
  "features.image_generation",
  "features.memories",
  "features.request_permissions_tool",
  "features.skill_search",
  "features.sleep_tool",
  "features.multi_agent_v2.enabled",
  "features.multi_agent_v2.usage_hint_text",
  "features.agent_message_board",
  "features.code_mode.enabled",
  "features.code_mode.direct_only_tool_namespaces",
  "features.context_management.experimental_mode",
] as const;
/** Type of root config key path values. */
export type RootConfigKeyPath = (typeof ROOT_CONFIG_KEY_PATHS)[number];

/**
 * Configuration keys accepted only long enough to clean up state written by older releases. These
 * keys are never part of a new desired configuration.
 */
export const LEGACY_ROOT_CONFIG_KEY_PATHS = [
  "model_auto_compact_token_limit",
  "features.context_management",
  "features.multi_agent_v2",
  "sandbox_workspace_write.network_access",
  "permissions.holycodex.extends",
  "permissions.holycodex.network.enabled",
] as const;
/** Type of legacy root config key path values. */
export type LegacyRootConfigKeyPath = (typeof LEGACY_ROOT_CONFIG_KEY_PATHS)[number];

/** Canonical holycodex agent types used by the Codex integration. */
export const HOLYCODEX_AGENT_TYPES = NATIVE_AGENT_TYPES;
/** Type of holy codex agent type values. */
export type HolyCodexAgentType = NativeAgentType;
/** Type of agent config key path values. */
export type AgentConfigKeyPath = `agents."${HolyCodexAgentType}".config_file`;
type LegacyAgentConfigKeyPath = 'agents."Reviewer.plan".config_file';
/** Type of managed config key path values. */
export type ManagedConfigKeyPath =
  | RootConfigKeyPath
  | AgentConfigKeyPath
  | LegacyAgentConfigKeyPath;

/** Type of managed config state key path values. */
export type ManagedConfigStateKeyPath = ManagedConfigKeyPath | LegacyRootConfigKeyPath;

/** Validates managed config key path values at the Codex boundary. */
export const ManagedConfigKeyPathSchema: Schema.Codec<ManagedConfigKeyPath, unknown> =
  Schema.String.check(Schema.makeFilter(isManagedConfigKeyPathShape)) as Schema.Codec<
    ManagedConfigKeyPath,
    unknown
  >;

/** Check whether a value names a root or native-agent config path managed by HolyCodex. */
export function isManagedConfigKeyPath(value: unknown): value is ManagedConfigKeyPath {
  return Schema.is(ManagedConfigKeyPathSchema)(value);
}

function isManagedConfigKeyPathShape(value: string): value is ManagedConfigKeyPath {
  if ((ROOT_CONFIG_KEY_PATHS as readonly string[]).includes(value)) return true;
  if (/^agents\.(?:explorer|librarian|worker|reviewer)\.config_file$/u.test(value)) return true;
  return PERSISTED_NATIVE_AGENT_TYPES.some(
    (agentType) => value === `agents."${agentType}".config_file`,
  );
}

const ManagedConfigStateKeyPathSchema: Schema.Codec<ManagedConfigStateKeyPath, unknown> =
  Schema.Union([
    ManagedConfigKeyPathSchema,
    Schema.Literals(LEGACY_ROOT_CONFIG_KEY_PATHS),
  ]) as Schema.Codec<ManagedConfigStateKeyPath, unknown>;

function isManagedConfigStateKeyPath(value: unknown): value is ManagedConfigStateKeyPath {
  return Schema.is(ManagedConfigStateKeyPathSchema)(value);
}

type ManagedEnum =
  | "gpt-6-astra"
  | "gpt-6.1-sol"
  | "gpt-6-sol"
  | "gpt-6-luna"
  | "gpt-5.6-terra"
  | "gpt-5.6-sol"
  | "gpt-5.6-luna"
  | Effort
  | "max"
  | "default"
  | "fast"
  | "live"
  | "cached"
  | "indexed"
  | "disabled"
  | ":workspace"
  | ":read-only"
  | "on-request"
  | "auto_review"
  | ":danger-full-access"
  | "holycodex"
  | "user"
  | "never"
  | "low"
  | "medium"
  | "high";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Type of managed config safe value values. */
export type ManagedConfigSafeValue =
  | { readonly kind: "enum"; readonly value: ManagedEnum }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "string_array"; readonly value: readonly string[] }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "relative_path"; readonly value: string }
  | { readonly kind: "absolute_path"; readonly value: string }
  | { readonly kind: "digest"; readonly value: Sha256Digest };
/** Type of managed config original value values. */
export type ManagedConfigOriginalValue = ManagedConfigSafeValue | { readonly kind: "absent" };

/** Validates managed config safe value values at the Codex boundary. */
const SafeMetadataTextSchema = Schema.String.check(Schema.isPattern(SAFE_IDENTIFIER_PATTERN));
const ManagedEnumSchema = Schema.Union([
  SafeMetadataTextSchema,
  Schema.Literals([":workspace", ":read-only", ":danger-full-access"]),
]);
const SafeManagedNumberSchema = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);
const Sha256DigestSchema: Schema.Codec<Sha256Digest, unknown> = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u),
) as Schema.Codec<Sha256Digest, unknown>;
const SafeRelativeConfigPathSchema = Schema.String.check(Schema.makeFilter(isRelativeConfigPath));
const SafeAbsoluteConfigPathSchema = Schema.String.check(
  Schema.makeFilter(isSafeAbsoluteConfigPath),
);
const SafeManagedTextSchema = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 && value.length <= 2_000),
);
const SafeToolNamespaceSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u));
const SafeToolNamespaceArraySchema = Schema.Array(SafeToolNamespaceSchema);
const ManagedConfigSafeValueShapeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["enum"]), value: ManagedEnumSchema }),
  Schema.Struct({ kind: Schema.Literals(["text"]), value: SafeManagedTextSchema }),
  Schema.Struct({ kind: Schema.Literals(["string_array"]), value: SafeToolNamespaceArraySchema }),
  Schema.Struct({
    kind: Schema.Literals(["number"]),
    value: SafeManagedNumberSchema,
  }),
  Schema.Struct({ kind: Schema.Literals(["boolean"]), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literals(["relative_path"]), value: SafeRelativeConfigPathSchema }),
  Schema.Struct({ kind: Schema.Literals(["absolute_path"]), value: SafeAbsoluteConfigPathSchema }),
  Schema.Struct({ kind: Schema.Literals(["digest"]), value: Sha256DigestSchema }),
]);
/** Schema for persisted managed configuration values safe to record and restore. */
export const ManagedConfigSafeValueSchema: Schema.Codec<ManagedConfigSafeValue, unknown> =
  ManagedConfigSafeValueShapeSchema.check(
    Schema.makeFilter((value) => hasOnlyKeys(value, ["kind", "value"])),
  ) as Schema.Codec<ManagedConfigSafeValue, unknown>;
/** Validates managed config original value values at the Codex boundary. */
export const ManagedConfigOriginalValueSchema: Schema.Codec<ManagedConfigOriginalValue, unknown> =
  Schema.Union([
    ManagedConfigSafeValueSchema,
    Schema.Struct({ kind: Schema.Literals(["absent"]) }),
  ]) as Schema.Codec<ManagedConfigOriginalValue, unknown>;

/** Ownership record for one managed runtime configuration key. */
export interface ManagedRuntimeConfigEntry {
  /** Installation identity that owns this entry. */
  readonly owner: "holycodex";
  /** Version of the persisted ownership-state schema. */
  readonly schema: string;
  /** Identifier of the HolyCodex installation that owns this entry. */
  readonly installId: string;
  /** Configuration key path tracked by this entry. */
  readonly keyPath: ManagedConfigStateKeyPath;
  /** Safe value captured before HolyCodex managed the key. */
  readonly originalValue: ManagedConfigOriginalValue;
  /** Last value written by HolyCodex for this key. */
  readonly lastManagedValue: ManagedConfigSafeValue;
}

/** Versioned ownership state for managed runtime configuration entries. */
export interface ManagedRuntimeConfigState {
  /** Installation identity that owns this state. */
  readonly owner: "holycodex";
  /** Version of the persisted ownership-state schema. */
  readonly schema: string;
  /** Identifier of the HolyCodex installation that owns this state. */
  readonly installId: string;
  /** Configuration entries currently owned by this installation. */
  readonly managed: Readonly<Record<string, ManagedRuntimeConfigEntry>>;
}

/** Validates managed runtime config entry values at the Codex boundary. */
const ManagedRuntimeConfigEntryShapeSchema = Schema.Struct({
  owner: Schema.Literals(["holycodex"]),
  schema: SafeMetadataTextSchema,
  installId: SafeMetadataTextSchema,
  keyPath: ManagedConfigStateKeyPathSchema,
  originalValue: ManagedConfigOriginalValueSchema,
  lastManagedValue: ManagedConfigSafeValueSchema,
});
/** Schema for one persisted managed runtime configuration ownership record. */
export const ManagedRuntimeConfigEntrySchema: Schema.Codec<ManagedRuntimeConfigEntry, unknown> =
  ManagedRuntimeConfigEntryShapeSchema.check(
    Schema.makeFilter(
      (value) =>
        hasOnlyKeys(value, [
          "owner",
          "schema",
          "installId",
          "keyPath",
          "originalValue",
          "lastManagedValue",
        ]) &&
        isSafeValueForKey(value.keyPath, value.lastManagedValue) &&
        (value.originalValue.kind === "absent" ||
          isSafeValueForKey(value.keyPath, value.originalValue)),
    ),
  ) as Schema.Codec<ManagedRuntimeConfigEntry, unknown>;
/** Validates managed runtime config state values at the Codex boundary. */
const ManagedRuntimeConfigStateShapeSchema = Schema.Struct({
  owner: Schema.Literals(["holycodex"]),
  schema: SafeMetadataTextSchema,
  installId: SafeMetadataTextSchema,
  managed: Schema.Record(Schema.String, ManagedRuntimeConfigEntrySchema),
});
/** Schema for the versioned persisted runtime configuration ownership state. */
export const ManagedRuntimeConfigStateSchema: Schema.Codec<ManagedRuntimeConfigState, unknown> =
  ManagedRuntimeConfigStateShapeSchema.check(
    Schema.makeFilter(
      (value) =>
        hasOnlyKeys(value, ["owner", "schema", "installId", "managed"]) &&
        Object.entries(value.managed).every(
          ([key, entry]) =>
            Schema.is(ManagedConfigStateKeyPathSchema)(key) && entry.keyPath === key,
        ),
    ),
  ) as unknown as Schema.Codec<ManagedRuntimeConfigState, unknown>;

/** Scalar value that can be written to a managed TOML configuration key. */
export type ManagedConfigWriteValue = string | number | boolean | readonly string[];

function isSafeMetadataText(value: unknown): value is string {
  return Schema.is(SafeMetadataTextSchema)(value);
}

function isManagedEnum(value: unknown): value is ManagedEnum {
  return Schema.is(ManagedEnumSchema)(value);
}

function isSafeManagedConfigNumber(value: unknown): value is number {
  return Schema.is(SafeManagedNumberSchema)(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeValueForKey(
  keyPath: ManagedConfigStateKeyPath,
  value: ManagedConfigSafeValue,
): boolean {
  switch (configKeyKind(keyPath)) {
    case "number":
      return value.kind === "number";
    case "boolean":
      return value.kind === "boolean";
    case "relative_path":
      return value.kind === "relative_path";
    case "absolute_path":
      return value.kind === "absolute_path" && Schema.is(SafeAbsoluteConfigPathSchema)(value.value);
    case "digest":
      return value.kind === "digest";
    case "string_array":
      return value.kind === "string_array" && Schema.is(SafeToolNamespaceArraySchema)(value.value);
    case "text":
      return value.kind === "text" && Schema.is(SafeManagedTextSchema)(value.value);
    case "enum":
      if (value.kind !== "enum") return false;
      if (keyPath === "model") {
        return (
          value.value === "gpt-6-astra" ||
          value.value === "gpt-6.1-sol" ||
          value.value === "gpt-6-sol" ||
          value.value === "gpt-6-luna" ||
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
          value.value === "max"
        );
      }
      if (keyPath === "service_tier") {
        return value.value === "default" || value.value === "fast";
      }
      if (keyPath === "approval_policy") {
        return value.value === "on-request" || value.value === "never";
      }
      if (keyPath === "approvals_reviewer") {
        return value.value === "auto_review" || value.value === "user";
      }
      if (keyPath === "default_permissions") {
        return (
          value.value === ":danger-full-access" ||
          value.value === ":workspace" ||
          value.value === ":read-only" ||
          value.value === "holycodex"
        );
      }
      if (keyPath === "permissions.holycodex.extends") {
        return (
          value.value === ":workspace" ||
          value.value === ":read-only" ||
          isSafeMetadataText(value.value)
        );
      }
      if (keyPath === "web_search") {
        return (
          value.value === "live" ||
          value.value === "cached" ||
          value.value === "indexed" ||
          value.value === "disabled"
        );
      }
      return value.value === "low" || value.value === "medium" || value.value === "high";
  }
}

/** Check whether a value is a structurally valid managed runtime config state. */
export function isManagedRuntimeConfigState(value: unknown): value is ManagedRuntimeConfigState {
  return Schema.is(ManagedRuntimeConfigStateSchema)(value);
}

/** Create empty managed runtime config state for an install identity. */
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

function isSafeAbsoluteConfigPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.includes("\u0000") &&
    /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value)
  );
}

/** Normalize a safe relative agent config path to slash-separated form. */
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
):
  | "enum"
  | "number"
  | "boolean"
  | "relative_path"
  | "absolute_path"
  | "digest"
  | "string_array"
  | "text" {
  if (keyPath === "developer_instructions") return "digest";
  if (keyPath === "model_catalog_json") return "absolute_path";
  if (keyPath.endsWith(".config_file")) return "relative_path";
  if (keyPath === "agents.max_concurrent_threads_per_session" || keyPath === "agents.max_depth")
    return "number";
  if (keyPath === "permissions.holycodex.extends") return "enum";
  if (keyPath === "features.multi_agent_v2.usage_hint_text") return "text";
  if (keyPath === "features.code_mode.direct_only_tool_namespaces") return "string_array";
  // Retained solely so persisted prior-release ownership can be validated and removed safely.
  if (keyPath === "model_auto_compact_token_limit") return "number";
  if (
    keyPath === "suppress_unstable_features_warning" ||
    keyPath === "include_collaboration_mode_instructions" ||
    keyPath === "tools.experimental_request_user_input.enabled" ||
    keyPath === "tools.update_plan.enabled" ||
    keyPath === "agents.enabled" ||
    keyPath === "features.multi_agent" ||
    keyPath === "features.default_mode_request_user_input" ||
    keyPath === "features.goals" ||
    keyPath === "features.image_generation" ||
    keyPath === "features.memories" ||
    keyPath === "features.request_permissions_tool" ||
    keyPath === "features.skill_search" ||
    keyPath === "features.sleep_tool" ||
    keyPath === "features.multi_agent_v2.enabled" ||
    keyPath === "features.agent_message_board" ||
    keyPath === "features.code_mode.enabled" ||
    keyPath === "features.context_management.experimental_mode" ||
    keyPath === "permissions.holycodex.network.enabled" ||
    (LEGACY_ROOT_CONFIG_KEY_PATHS as readonly string[]).includes(keyPath as string)
  ) {
    return "boolean";
  }
  return "enum";
}

function isExpectedValueForKey(keyPath: ManagedConfigKeyPath, value: TomlValue): boolean {
  const kind = configKeyKind(keyPath);
  if (kind === "number") return isSafeManagedConfigNumber(value);
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "string_array") return Schema.is(SafeToolNamespaceArraySchema)(value);
  if (kind === "text") return Schema.is(SafeManagedTextSchema)(value);
  if (kind === "relative_path") return typeof value === "string" && isRelativeConfigPath(value);
  if (kind === "absolute_path") return typeof value === "string" && isSafeAbsoluteConfigPath(value);
  if (kind === "digest") return typeof value === "string";
  if (keyPath === "model") {
    return value === "gpt-6-astra" || value === "gpt-6.1-sol" || value === "gpt-6-luna";
  }
  return typeof value === "string" && isManagedEnum(value);
}

/** Convert one live TOML value into the only representation allowed in state. */
export function summarizeManagedConfigValue(
  keyPath: ManagedConfigStateKeyPath,
  value: TomlValue,
): Promise<ManagedConfigSafeValue> {
  return Effect.runPromise(summarizeManagedConfigValueEffect(keyPath, value));
}

/** Convert a live TOML value into a safe state summary without crossing the Effect boundary. */
export function summarizeManagedConfigValueEffect(
  keyPath: ManagedConfigStateKeyPath,
  value: TomlValue,
): Effect.Effect<ManagedConfigSafeValue, CodexError> {
  if (!isManagedConfigStateKeyPath(keyPath) || !isTomlValue(value)) {
    return Effect.fail(invalidData("managed config value", { keyPath }));
  }
  const kind = configKeyKind(keyPath);
  if (kind === "number" && isSafeManagedConfigNumber(value)) return Effect.succeed({ kind, value });
  if (kind === "boolean" && typeof value === "boolean") return Effect.succeed({ kind, value });
  if (kind === "string_array" && Schema.is(SafeToolNamespaceArraySchema)(value)) {
    return Effect.succeed({ kind, value });
  }
  if (kind === "text" && Schema.is(SafeManagedTextSchema)(value))
    return Effect.succeed({ kind, value });
  if (kind === "relative_path" && typeof value === "string" && isRelativeConfigPath(value)) {
    return Effect.succeed({ kind, value: normalizeRelativeConfigPath(value) });
  }
  if (kind === "absolute_path" && typeof value === "string" && isSafeAbsoluteConfigPath(value)) {
    return Effect.succeed({ kind, value });
  }
  if (kind === "enum" && typeof value === "string" && isManagedEnum(value)) {
    return Effect.succeed({ kind, value });
  }
  return Effect.map(
    Effect.tryPromise({
      try: () =>
        domainSeparatedSha256("holycodex-managed-config-value", [
          canonicalJsonUtf8({ keyPath, value }),
        ]),
      catch: (cause) => invalidData("managed config value digest", { keyPath }, cause),
    }),
    (digest) => ({ kind: "digest", value: digest }),
  );
}

function safeValueToToml(
  value: ManagedConfigSafeValue,
): string | number | boolean | readonly string[] | undefined {
  if (
    value.kind === "enum" ||
    value.kind === "text" ||
    value.kind === "number" ||
    value.kind === "boolean" ||
    value.kind === "relative_path" ||
    value.kind === "absolute_path"
  ) {
    return value.value;
  }
  if (value.kind === "string_array") return value.value;
  return undefined;
}

/** Updated document and ownership state plus keys that drifted during merge. */
export interface ManagedRuntimeConfigMerge {
  /** Parsed TOML document after applying managed values. */
  readonly document: TomlDocument;
  /** Updated ownership state for the merged configuration. */
  readonly state: ManagedRuntimeConfigState;
  /** Keys whose current values differ from the last managed values. */
  readonly driftedKeys: readonly ManagedConfigKeyPath[];
}

/**
 * Merge only managed keys into a parsed document. Existing managed keys are compared individually;
 * a changed value is preserved and reported as drift.
 */
export function mergeManagedRuntimeConfig(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>,
  metadata: Readonly<{ readonly schema: string; readonly installId: string }>,
): Promise<ManagedRuntimeConfigMerge> {
  return Effect.runPromise(mergeManagedRuntimeConfigEffect(document, current, desired, metadata));
}

/** Merge managed runtime configuration without crossing the Effect boundary. */
export function mergeManagedRuntimeConfigEffect(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>,
  metadata: Readonly<{ readonly schema: string; readonly installId: string }>,
): Effect.Effect<ManagedRuntimeConfigMerge, CodexError> {
  return Effect.gen(function* () {
    if (
      !isTomlTable(document) ||
      !isManagedRuntimeConfigState(current) ||
      !isSafeMetadataText(metadata.schema) ||
      !isSafeMetadataText(metadata.installId)
    ) {
      return yield* Effect.fail(invalidData("managed runtime config", {}));
    }
    const outputEntries: Record<string, ManagedRuntimeConfigEntry> = { ...current.managed };
    let output = cloneTomlTable(document);
    const driftedKeys: ManagedConfigKeyPath[] = [];
    for (const [rawKeyPath, nextValue] of Object.entries(desired)) {
      if (
        !isManagedConfigKeyPath(rawKeyPath) ||
        (typeof nextValue !== "string" &&
          typeof nextValue !== "number" &&
          typeof nextValue !== "boolean" &&
          !Array.isArray(nextValue))
      ) {
        return yield* Effect.fail(invalidData("managed config key", rawKeyPath));
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
          live === undefined ? undefined : yield* summarizeManagedConfigValueEffect(keyPath, live);
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
        (live === undefined
          ? { kind: "absent" }
          : yield* summarizeManagedConfigValueEffect(keyPath, live));
      if (!isExpectedValueForKey(keyPath, nextValue)) {
        return yield* Effect.fail(invalidData("managed config value", { keyPath }));
      }
      output = writeTomlPath(output, keyPath, nextValue);
      outputEntries[keyPath] = {
        owner: "holycodex",
        schema: metadata.schema,
        installId: metadata.installId,
        keyPath,
        originalValue,
        lastManagedValue: yield* summarizeManagedConfigValueEffect(keyPath, nextValue),
      };
    }
    const state: ManagedRuntimeConfigState = {
      owner: "holycodex",
      schema: metadata.schema,
      installId: metadata.installId,
      managed: outputEntries,
    };
    if (!isManagedRuntimeConfigState(state))
      return yield* Effect.fail(invalidData("managed runtime config state", {}));
    return { document: output, state, driftedKeys };
  });
}

/** Data contract for managed runtime config cleanup. */
export interface ManagedRuntimeConfigCleanup {
  /** Document in the managed runtime config cleanup contract. */
  readonly document: TomlDocument;
  /** State in the managed runtime config cleanup contract. */
  readonly state: ManagedRuntimeConfigState;
  /** Restored keys in the managed runtime config cleanup contract. */
  readonly restoredKeys: readonly ManagedConfigStateKeyPath[];
  /** Preserved keys in the managed runtime config cleanup contract. */
  readonly preservedKeys: readonly ManagedConfigStateKeyPath[];
  /** Unresolved keys in the managed runtime config cleanup contract. */
  readonly unresolvedKeys: readonly ManagedConfigStateKeyPath[];
}

/** Restore only unchanged values owned by the current HolyCodex installation. */
export function cleanupManagedRuntimeConfig(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  metadata: Readonly<{ readonly schema: string; readonly installId: string }>,
): Promise<ManagedRuntimeConfigCleanup> {
  return Effect.runPromise(cleanupManagedRuntimeConfigEffect(document, current, metadata));
}

/** Restore managed runtime configuration without crossing the Effect boundary. */
export function cleanupManagedRuntimeConfigEffect(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  metadata: Readonly<{ readonly schema: string; readonly installId: string }>,
): Effect.Effect<ManagedRuntimeConfigCleanup, CodexError> {
  return Effect.gen(function* () {
    if (!isTomlTable(document) || !isManagedRuntimeConfigState(current)) {
      return yield* Effect.fail(invalidData("managed runtime config", {}));
    }
    let output = cloneTomlTable(document);
    const remaining: Record<string, ManagedRuntimeConfigEntry> = { ...current.managed };
    const restoredKeys: ManagedConfigStateKeyPath[] = [];
    const preservedKeys: ManagedConfigStateKeyPath[] = [];
    const unresolvedKeys: ManagedConfigStateKeyPath[] = [];
    for (const [rawKeyPath, entry] of Object.entries(current.managed)) {
      if (!isManagedConfigStateKeyPath(rawKeyPath)) {
        return yield* Effect.fail(invalidData("managed config key", rawKeyPath));
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
      const liveSummary =
        live === undefined ? undefined : yield* summarizeManagedConfigValueEffect(keyPath, live);
      const unchanged =
        liveSummary !== undefined &&
        JSON.stringify(liveSummary) === JSON.stringify(entry.lastManagedValue);
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
  });
}

/** Data contract for managed config drift. */
export interface ManagedConfigDrift {
  /** Key path in the managed config drift contract. */
  readonly keyPath: ManagedConfigKeyPath;
  /** Current lifecycle status of the entity. */
  readonly status: "unmanaged" | "unchanged" | "drifted";
  /** Current in the managed config drift contract. */
  readonly current?: ManagedConfigSafeValue;
  /** Expected in the managed config drift contract. */
  readonly expected?: ManagedConfigSafeValue;
}

/** Readback comparison that returns only safe summaries, never raw values. */
export function compareManagedConfigKey(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  keyPath: ManagedConfigKeyPath,
): Promise<ManagedConfigDrift> {
  return Effect.runPromise(compareManagedConfigKeyEffect(document, current, keyPath));
}

/** Compare one managed key without crossing the Effect boundary. */
export function compareManagedConfigKeyEffect(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  keyPath: ManagedConfigKeyPath,
): Effect.Effect<ManagedConfigDrift, CodexError> {
  return Effect.gen(function* () {
    if (!isManagedConfigKeyPath(keyPath) || !isManagedRuntimeConfigState(current)) {
      return yield* Effect.fail(invalidData("managed config key", keyPath));
    }
    const entry = current.managed[keyPath];
    const live = readTomlPath(document, keyPath);
    const summary =
      live === undefined ? undefined : yield* summarizeManagedConfigValueEffect(keyPath, live);
    if (!entry) {
      return summary === undefined
        ? { keyPath, status: "unmanaged" as const }
        : { keyPath, status: "unmanaged" as const, current: summary };
    }
    return {
      keyPath,
      status:
        summary !== undefined && JSON.stringify(summary) === JSON.stringify(entry.lastManagedValue)
          ? ("unchanged" as const)
          : ("drifted" as const),
      expected: entry.lastManagedValue,
      ...(summary === undefined ? {} : { current: summary }),
    };
  });
}

/** Validate and return managed runtime configuration state. */
export function assertManagedRuntimeConfigState(value: unknown): ManagedRuntimeConfigState {
  if (!isManagedRuntimeConfigState(value)) throw invalidData("managed runtime config state", {});
  return value;
}
