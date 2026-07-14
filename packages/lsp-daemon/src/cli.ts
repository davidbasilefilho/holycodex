#!/usr/bin/env node
import { argv, stderr } from "node:process";
import { stackOrMessageFromError } from "@holycodex/mcp-stdio-core";

import { runMcpStdioProxy } from "./proxy.js";
import { runDaemon } from "./run-daemon.js";

async function main(): Promise<void> {
  const [command = "mcp"] = argv.slice(2);

  if (command === "daemon") {
    await runDaemon();
    return;
  }
  if (command === "mcp") {
    await runMcpStdioProxy();
    return;
  }

  stderr.write("Usage: holycodex-lsp-daemon [mcp | daemon]\n");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  stderr.write(`${stackOrMessageFromError(error)}\n`);
  process.exitCode = 1;
});
