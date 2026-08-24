// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import * as Schema from "effect/Schema";

import { contextCwd, contextEnv } from "../request-context.ts";
import { decodeLspSchema, JsonObjectSchema, JsonValueSchema } from "./schema.ts";
import { BUILTIN_SERVERS } from "./server-definitions.ts";
import type { JsonObject } from "./schema.ts";
import type { ResolvedServer } from "./types.ts";

const ConfigSchema = Schema.Struct({
  lsp: Schema.optional(Schema.Record({ key: Schema.String, value: JsonValueSchema })),
});
const EntrySchema = Schema.Struct({
  disabled: Schema.optional(Schema.Boolean),
  command: Schema.optional(Schema.Array(Schema.String)),
  extensions: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(
    Schema.Number.pipe(Schema.filter((value: number) => Number.isFinite(value))),
  ),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  initialization: Schema.optional(JsonObjectSchema),
});
type ConfigValue = { readonly lsp?: Readonly<Record<string, unknown>> | undefined };
type Entry = {
  readonly disabled?: boolean | undefined;
  readonly command?: readonly string[] | undefined;
  readonly extensions?: readonly string[] | undefined;
  readonly priority?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly initialization?: JsonObject | undefined;
};

export interface ServerWithSource extends ResolvedServer {
  readonly source: "project" | "user" | "builtin";
}

export interface ConfigFileSystem {
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
}

const defaultFileSystem: ConfigFileSystem = {
  exists: existsSync,
  readText: (path) => readFileSync(path, "utf8"),
};

/** Returns the project and user configuration paths after precedence resolution. */
export function getConfigPaths(): { readonly project: string; readonly user: string } {
  return {
    project: getProjectConfigPaths()[0] ?? join(contextCwd(), ".codex", "lsp-client.json"),
    user: getUserConfigPath(),
  };
}

function resolveProjectConfigPath(path: string): string {
  return isAbsolute(path) ? path : join(contextCwd(), path);
}

function getProjectConfigPaths(): readonly string[] {
  const override = contextEnv("HOLYCODEX_LSP_PROJECT_CONFIG");
  return override === undefined
    ? [join(contextCwd(), ".codex", "lsp-client.json")]
    : override.split(delimiter).filter(Boolean).map(resolveProjectConfigPath);
}

function getUserConfigPath(): string {
  const override = contextEnv("HOLYCODEX_LSP_USER_CONFIG");
  if (override === undefined) return join(homedir(), ".codex", "lsp-client.json");
  return isAbsolute(override) ? override : join(homedir(), override);
}

function loadJsonFile(path: string, fileSystem: ConfigFileSystem): ConfigValue | null {
  if (!fileSystem.exists(path)) return null;
  try {
    const parsed: unknown = JSON.parse(fileSystem.readText(path));
    const config = decodeLspSchema(ConfigSchema, parsed);
    if (config === undefined) return null;
    return config;
  } catch {
    return null;
  }
}

/** Loads valid project and user configuration files, ignoring malformed files. */
export function loadAllConfigs(
  fileSystem: ConfigFileSystem = defaultFileSystem,
): Map<"project" | "user", ConfigValue> {
  const configs = new Map<"project" | "user", ConfigValue>();
  const project = getProjectConfigPaths()
    .map((path) => loadJsonFile(path, fileSystem))
    .find((value) => value !== null);
  if (project !== undefined) configs.set("project", project);
  const user = loadJsonFile(getUserConfigPath(), fileSystem);
  if (user !== null) configs.set("user", user);
  return configs;
}

function parseEntry(value: unknown): Entry | null {
  const parsed = decodeLspSchema(EntrySchema, value);
  return parsed ?? null;
}

function createServer(
  id: string,
  entry: Entry,
  source: "project" | "user",
): ServerWithSource | null {
  const builtin = BUILTIN_SERVERS[id];
  const command = entry.command ?? builtin?.command;
  const extensions = entry.extensions ?? builtin?.extensions;
  if (
    command === undefined ||
    extensions === undefined ||
    command.length === 0 ||
    extensions.length === 0
  )
    return null;
  const server: ServerWithSource = {
    id,
    command: [...command],
    extensions: [...extensions],
    priority: entry.priority ?? 0,
    source,
    ...(entry.env === undefined ? {} : { env: entry.env }),
    ...(entry.initialization === undefined ? {} : { initialization: entry.initialization }),
  };
  return server;
}

/** Merges project, user, then builtin definitions with deterministic precedence. */
export function getMergedServers(
  fileSystem: ConfigFileSystem = defaultFileSystem,
): ServerWithSource[] {
  const configs = loadAllConfigs(fileSystem);
  const servers: ServerWithSource[] = [];
  const disabled = new Set<string>();
  const seen = new Set<string>();
  for (const source of ["project", "user"] as const) {
    const config = configs.get(source);
    for (const [id, raw] of Object.entries(config?.lsp ?? {})) {
      const entry = parseEntry(raw);
      if (entry === null) continue;
      if (entry.disabled === true) {
        disabled.add(id);
        continue;
      }
      if (seen.has(id)) continue;
      const server = createServer(id, entry, source);
      if (server !== null) {
        servers.push(server);
        seen.add(id);
      }
    }
  }
  for (const [id, server] of Object.entries(BUILTIN_SERVERS)) {
    if (disabled.has(id) || seen.has(id)) continue;
    servers.push({
      id,
      command: server.command,
      extensions: server.extensions,
      priority: -100,
      source: "builtin",
    });
  }
  return servers.sort((a, b) => {
    const order = { project: 0, user: 1, builtin: 2 } as const;
    return order[a.source] - order[b.source] || b.priority - a.priority;
  });
}

/** Returns server ids disabled by any valid configuration file. */
export function getDisabledServerIds(
  fileSystem: ConfigFileSystem = defaultFileSystem,
): Set<string> {
  const disabled = new Set<string>();
  for (const config of loadAllConfigs(fileSystem).values()) {
    for (const [id, raw] of Object.entries(config.lsp ?? {})) {
      if (parseEntry(raw)?.disabled === true) disabled.add(id);
    }
  }
  return disabled;
}
