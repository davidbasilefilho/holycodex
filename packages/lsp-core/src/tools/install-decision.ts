// SPDX-License-Identifier: Apache-2.0

import { getMergedServers } from "../lsp/config-loader.ts";
import { isInstallDecision, recordInstallDecision } from "../lsp/server-install-state.ts";
import { requireString } from "./parameters.ts";
import { text } from "./result.ts";
/** Records an explicit user decision without executing an installer. */
export async function executeLspInstallDecision(params: Record<string, unknown>) {
  const serverId = requireString(params, "server_id");
  const decision = params["decision"];
  if (!isInstallDecision(decision))
    return text(
      `Invalid decision '${String(decision)}'. Expected "declined" or "allowed".`,
      { serverId, errorKind: "invalid_decision" },
      true,
    );
  const known = new Set(getMergedServers().map((server) => server.id));
  if (!known.has(serverId))
    return text(
      `Unknown LSP server '${serverId}'.`,
      { serverId, errorKind: "unknown_server" },
      true,
    );
  recordInstallDecision(serverId, decision);
  return text(`Recorded install decision for '${serverId}': ${decision}.`, { serverId, decision });
}
