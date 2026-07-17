import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { UnknownRecordSchema } from "@holycodex/mcp-stdio-core/schemas";
import { z } from "zod";

import { contextCwd, contextEnv } from "../request-context.js";
import { BUILTIN_SERVERS } from "./server-definitions.js";
import type { ResolvedServer } from "./types.js";

const LspEntrySchema = z.looseObject({
  disabled: z.boolean().optional(),
  command: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  priority: z.number().finite().optional(),
  env: z.record(z.string(), z.string()).optional(),
  initialization: UnknownRecordSchema.optional(),
});
type LspEntry = z.infer<typeof LspEntrySchema>;

const ConfigJsonSchema = z.looseObject({
  lsp: z.record(z.string(), z.unknown()).optional(),
});
type ConfigJson = z.infer<typeof ConfigJsonSchema>;

type ConfigSource = "project" | "user";

export interface ServerWithSource extends ResolvedServer {
  source: "project" | "user" | "builtin";
}

/** Gets config paths. */
export function getConfigPaths(): { project: string; user: string } {
  return {
    project: getProjectConfigPaths()[0] ?? join(process.cwd(), ".codex", "lsp-client.json"),
    user: getUserConfigPath(),
  };
}

function resolveProjectConfigPath(path: string): string {
  return isAbsolute(path) ? path : join(contextCwd(), path);
}

function getProjectConfigPaths(): string[] {
  const projectOverride = contextEnv("LSP_TOOLS_MCP_PROJECT_CONFIG");
  if (projectOverride) {
    return projectOverride.split(delimiter).filter(Boolean).map(resolveProjectConfigPath);
  }
  return [join(contextCwd(), ".codex", "lsp-client.json")];
}

function getUserConfigPath(): string {
  const userOverride = contextEnv("LSP_TOOLS_MCP_USER_CONFIG");
  if (!userOverride) return join(homedir(), ".codex", "lsp-client.json");
  return isAbsolute(userOverride) ? userOverride : join(homedir(), userOverride);
}

function loadJsonFile(path: string): ConfigJson | null {
  if (!existsSync(path)) return null;
  try {
    return ConfigJsonSchema.safeParse(JSON.parse(readFileSync(path, "utf-8"))).data ?? null;
  } catch {
    return null;
  }
}

/** Loads all configs. */
export function loadAllConfigs(): Map<ConfigSource, ConfigJson> {
  const configs = new Map<ConfigSource, ConfigJson>();

  const project = loadFirstJsonFile(getProjectConfigPaths());
  if (project) configs.set("project", project);

  const user = loadJsonFile(getUserConfigPath());
  if (user) configs.set("user", user);

  return configs;
}

function loadFirstJsonFile(paths: readonly string[]): ConfigJson | null {
  for (const path of paths) {
    const config = loadJsonFile(path);
    if (config) return config;
  }
  return null;
}

/** Gets merged servers. */
export function getMergedServers(): ServerWithSource[] {
  const configs = loadAllConfigs();
  const servers: ServerWithSource[] = [];
  const disabled = new Set<string>();
  const seen = new Set<string>();

  const sources: ConfigSource[] = ["project", "user"];

  for (const source of sources) {
    const config = configs.get(source);
    if (!config?.lsp) continue;

    for (const [id, rawEntry] of Object.entries(config.lsp)) {
      const entry = parseLspEntry(rawEntry);
      if (!entry) continue;
      if (entry.disabled) {
        disabled.add(id);
        continue;
      }

      if (seen.has(id)) continue;
      const server = createServerFromEntry(id, entry, source);
      if (!server) continue;

      servers.push(server);
      seen.add(id);
    }
  }

  for (const [id, config] of Object.entries(BUILTIN_SERVERS)) {
    if (disabled.has(id) || seen.has(id)) continue;

    servers.push({
      id,
      command: config.command,
      extensions: config.extensions,
      priority: -100,
      source: "builtin",
    });
  }

  return servers.sort((a, b) => {
    if (a.source !== b.source) {
      const order: Record<"project" | "user" | "builtin", number> = {
        project: 0,
        user: 1,
        builtin: 2,
      };
      return order[a.source] - order[b.source];
    }
    return b.priority - a.priority;
  });
}

function createServerFromEntry(
  id: string,
  entry: LspEntry,
  source: ConfigSource,
): ServerWithSource | null {
  const builtin = BUILTIN_SERVERS[id];
  if (source === "project") {
    if (!builtin) return null;
    const server = createServer({
      id,
      command: builtin.command,
      extensions: entry.extensions ?? builtin.extensions,
      priority: entry.priority ?? 0,
      source,
    });
    if (entry.initialization !== undefined) {
      server.initialization = entry.initialization;
    }
    return server;
  }

  if (entry.command && entry.extensions) {
    const server = createServer({
      id,
      command: entry.command,
      extensions: entry.extensions,
      priority: entry.priority ?? 0,
      source,
    });
    applyOptionalServerFields(server, entry);
    return server;
  }

  if (!builtin) return null;
  const server = createServer({
    id,
    command: entry.command ?? builtin.command,
    extensions: entry.extensions ?? builtin.extensions,
    priority: entry.priority ?? 0,
    source,
  });
  applyOptionalServerFields(server, entry);
  return server;
}

function createServer(input: {
  readonly id: string;
  readonly command: string[];
  readonly extensions: string[];
  readonly priority: number;
  readonly source: ConfigSource;
  readonly env?: Record<string, string>;
  readonly initialization?: Record<string, unknown>;
}): ServerWithSource {
  const server: ServerWithSource = {
    id: input.id,
    command: input.command,
    extensions: input.extensions,
    priority: input.priority,
    source: input.source,
  };
  if (input.env !== undefined) {
    server.env = input.env;
  }
  if (input.initialization !== undefined) {
    server.initialization = input.initialization;
  }
  return server;
}

function applyOptionalServerFields(server: ServerWithSource, entry: LspEntry): void {
  if (entry.env !== undefined) {
    server.env = entry.env;
  }
  if (entry.initialization !== undefined) {
    server.initialization = entry.initialization;
  }
}

function parseLspEntry(value: unknown): LspEntry | null {
  return LspEntrySchema.safeParse(value).data ?? null;
}

/** Gets disabled server ids. */
export function getDisabledServerIds(): Set<string> {
  const configs = loadAllConfigs();
  const disabled = new Set<string>();

  for (const config of configs.values()) {
    if (!config.lsp) continue;
    for (const [id, rawEntry] of Object.entries(config.lsp)) {
      const entry = parseLspEntry(rawEntry);
      if (!entry) continue;
      if (entry.disabled) disabled.add(id);
    }
  }

  return disabled;
}
