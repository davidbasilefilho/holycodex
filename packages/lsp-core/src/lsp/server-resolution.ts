// SPDX-License-Identifier: Apache-2.0

import { getDisabledServerIds, getMergedServers, type ConfigFileSystem } from "./config-loader.ts";
import { BUILTIN_SERVERS, LSP_INSTALL_HINTS } from "./server-definitions.ts";
import { isServerInstalled, type ServerInstallationOptions } from "./server-installation.ts";
import type { ServerLookupResult } from "./types.ts";

export interface ServerStatus {
  readonly id: string;
  readonly installed: boolean;
  readonly extensions: readonly string[];
  readonly disabled: boolean;
  readonly source: string;
  readonly priority: number;
}

export interface ServerResolutionOptions {
  readonly fileSystem?: ConfigFileSystem;
  readonly installation?: ServerInstallationOptions;
}

/** Finds the first configured and installed server for an effective extension. */
export function findServerForExtension(
  extension: string,
  options: ServerResolutionOptions = {},
): ServerLookupResult {
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const servers = getMergedServers(options.fileSystem);
  for (const server of servers) {
    if (
      server.extensions.includes(normalized) &&
      isServerInstalled(server.command, options.installation)
    ) {
      return {
        status: "found",
        server: {
          id: server.id,
          command: [...server.command],
          extensions: [...server.extensions],
          priority: server.priority,
          ...(server.env === undefined ? {} : { env: server.env }),
          ...(server.initialization === undefined ? {} : { initialization: server.initialization }),
        },
      };
    }
  }
  for (const server of servers) {
    if (server.extensions.includes(normalized)) {
      return {
        status: "not_installed",
        server: { id: server.id, command: [...server.command], extensions: [...server.extensions] },
        installHint:
          LSP_INSTALL_HINTS[server.id] ??
          `Install '${server.command[0]}' and ensure it is in your PATH`,
      };
    }
  }
  return {
    status: "not_configured",
    extension: normalized,
    availableServers: [...new Set(servers.map((server) => server.id))],
  };
}

/** Lists configured servers without starting them. */
export function getAllServers(options: ServerResolutionOptions = {}): ServerStatus[] {
  const servers = getMergedServers(options.fileSystem);
  const disabled = getDisabledServerIds(options.fileSystem);
  const result: ServerStatus[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.id)) continue;
    result.push({
      id: server.id,
      installed: isServerInstalled(server.command, options.installation),
      extensions: [...server.extensions],
      disabled: false,
      source: server.source,
      priority: server.priority,
    });
    seen.add(server.id);
  }
  for (const id of disabled) {
    if (seen.has(id)) continue;
    const builtin = BUILTIN_SERVERS[id];
    result.push({
      id,
      installed:
        builtin === undefined ? false : isServerInstalled(builtin.command, options.installation),
      extensions: builtin?.extensions ?? [],
      disabled: true,
      source: "disabled",
      priority: 0,
    });
  }
  return result;
}

/** Formats an actionable unavailable/setup-required diagnostic. */
export function formatServerLookupError(
  result: Exclude<ServerLookupResult, { status: "found" }>,
): string {
  if (result.status === "not_installed") {
    return [
      `LSP server '${result.server.id}' for ${result.server.extensions.join(", ")} is NOT INSTALLED.`,
      "",
      `Command not found: ${result.server.command[0] ?? result.server.id}`,
      "",
      "Setup prescription:",
      `  ${result.installHint}`,
      "",
      "Automatic network installation is disabled; install it explicitly, then retry.",
    ].join("\n");
  }
  return [
    `No LSP server configured for extension: ${result.extension}`,
    "",
    `Available servers: ${result.availableServers.slice(0, 10).join(", ")}${result.availableServers.length > 10 ? "..." : ""}`,
    "",
    "Configure a custom server in '.codex/lsp-client.json' with an explicit command and extension.",
  ].join("\n");
}
