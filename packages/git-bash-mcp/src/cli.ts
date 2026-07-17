#!/usr/bin/env node
import { argv, stderr } from "node:process";

import { stackOrMessageFromError } from "@holycodex/mcp-stdio-core";

import { runMcpStdioServer } from "./mcp";

async function main(): Promise<void> {
  const [command = "mcp"] = argv.slice(2);
  if (command === "mcp") {
    await runMcpStdioServer(process.stdin, process.stdout);
    return;
  }

  stderr.write("Usage: holycodex-git-bash [mcp]\n");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  stderr.write(`${stackOrMessageFromError(error)}\n`);
  process.exitCode = 1;
});
