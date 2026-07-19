#!/usr/bin/env node
import { stderr } from "node:process";

import { stackOrMessageFromError } from "@holycodex/mcp-stdio-core";

import { runCodexSlimEditMcpStdioServer } from "./mcp.js";
import { CODEX_SLIM_EDIT_VERSION, isVersionRequest } from "./version.js";

/** Starts the CodexSlimEdit MCP stdio entrypoint. */
async function main(): Promise<void> {
  if (isVersionRequest(process.argv.slice(2))) {
    process.stdout.write(`${CODEX_SLIM_EDIT_VERSION}\n`);
    return;
  }
  await runCodexSlimEditMcpStdioServer(process.stdin, process.stdout);
}

main().catch((error: unknown) => {
  stderr.write(`${stackOrMessageFromError(error)}\n`);
  process.exitCode = 1;
});
