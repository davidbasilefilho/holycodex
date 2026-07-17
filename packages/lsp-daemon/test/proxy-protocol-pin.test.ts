import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../cli/src/catalog.ts";

import { type DaemonPaths, daemonPaths } from "../src/paths.js";
import { runMcpStdioProxy } from "../src/proxy.js";
import { collectingWritable, inputStream, noSpawn } from "./proxy-fixtures.js";

describe("lsp-daemon MCP proxy protocol pins", () => {
  it("given initialize request when proxied then exact server info and capabilities stay stable", async () => {
    const out: string[] = [];

    await runMcpStdioProxy({
      input: inputStream([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      ]),
      output: collectingWritable(out),
      paths: inertPaths(),
      ensure: noSpawn,
    });

    expect(parseSingleResponse(out)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lsp", version: VERSION },
        protocolVersion: "2024-11-05",
      },
    });
  });

  it("given malformed stdio line when proxied then parse error envelope includes parser data", async () => {
    const out: string[] = [];

    await runMcpStdioProxy({
      input: Readable.from(["garbage\n"]),
      output: collectingWritable(out),
      paths: inertPaths(),
      ensure: noSpawn,
    });

    expect(parseSingleResponse(out)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error",
        data: "Unexpected token 'g', \"garbage\" is not valid JSON",
      },
    });
  });
});

function inertPaths(): DaemonPaths {
  return daemonPaths({ CODEX_LSP_DAEMON_DIR: "/tmp/holycodex-lsp-daemon-protocol-pin" }, "test");
}

function parseSingleResponse(chunks: readonly string[]): unknown {
  return JSON.parse(chunks.join("").trim());
}
