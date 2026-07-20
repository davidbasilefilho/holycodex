#!/usr/bin/env node
import { stderr } from "node:process";

import { stackOrMessageFromError } from "@holycodex/mcp-stdio-core";

import { CLI_HELP, getCliAction } from "./cli-options.js";
import { runCodexSlimEditMcpStdioServer } from "./mcp.js";
import { CODEX_SLIM_EDIT_VERSION } from "./version.js";

/** Starts the CodexSlimEdit MCP stdio entrypoint. */
async function main(): Promise<void> {
  const action = getCliAction(process.argv.slice(2));
  if (action === "version") {
    process.stdout.write(`${CODEX_SLIM_EDIT_VERSION}\n`);
    return;
  }
  if (action === "help") {
    process.stdout.write(`${CLI_HELP}\n`);
    return;
  }
  await runCodexSlimEditMcpStdioServer(process.stdin, process.stdout);
}

main().catch((error: unknown) => {
  stderr.write(`${stackOrMessageFromError(error)}\n`);
  process.exitCode = 1;
});
