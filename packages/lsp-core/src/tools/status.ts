// SPDX-License-Identifier: Apache-2.0

import { getLspManager } from "../lsp/manager.ts";
import { getAllServers } from "../lsp/server-resolution.ts";
import { text } from "./result.ts";
import type { ToolExecutionResult } from "./types.ts";
/** Lists configured servers and active clients without starting a server. */
export async function executeLspStatus(): Promise<ToolExecutionResult> {
  const servers = getAllServers();
  const snapshots = getLspManager().getSnapshot();
  const lines = [
    `Configured LSP servers: ${servers.length}`,
    `Installed LSP servers: ${servers.filter((server) => server.installed && !server.disabled).length}`,
    "",
    ...servers.map(
      (server) =>
        `- ${server.id}: ${server.disabled ? "disabled" : server.installed ? "installed" : "missing"}; source=${server.source}; extensions=${server.extensions.join(", ")}`,
    ),
    "",
    `Active LSP clients: ${snapshots.length}`,
    ...snapshots.map(
      (snapshot) =>
        `- ${snapshot.serverId}: ${snapshot.alive ? (snapshot.isInitializing ? "initializing" : "alive") : "dead"}; root=${snapshot.root}; refs=${snapshot.refCount}`,
    ),
  ];
  return text(lines.join("\n"), { servers, snapshots });
}
