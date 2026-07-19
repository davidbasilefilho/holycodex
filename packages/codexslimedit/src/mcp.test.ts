import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@holycodex/mcp-stdio-core", async () => await import("../../mcp-stdio-core/src/index.ts"));

import { handleCodexSlimEditMcpRequest } from "./mcp";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("codexslimedit MCP", () => {
  it("lists concise read and edit schemas", async () => {
    const response = await handleCodexSlimEditMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(response).toMatchObject({
      result: {
        tools: [
          { name: "read", inputSchema: { required: ["filePath"] } },
          { name: "edit", inputSchema: { required: ["filePath", "oldString", "newString"] } },
        ],
      },
    });
  });

  it("returns JSON-RPC errors for malformed and unknown requests", async () => {
    await expect(handleCodexSlimEditMcpRequest({ id: 1 })).resolves.toMatchObject({
      error: { code: -32600 },
    });
    await expect(
      handleCodexSlimEditMcpRequest({ jsonrpc: "2.0", id: 1, method: "nope" }),
    ).resolves.toMatchObject({ error: { code: -32601 } });
    await expect(
      handleCodexSlimEditMcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "edit", arguments: {} },
      }),
    ).resolves.toMatchObject({
      result: { isError: true },
    });
  });

  it("returns concise read and edit success plus typed edit failures", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "note.txt"), "hello\n", "utf8");

    await expect(
      handleCodexSlimEditMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read", arguments: { filePath: "note.txt" } },
        },
        { root },
      ),
    ).resolves.toMatchObject({
      result: { content: [{ text: "note.txt\nhello\n" }], isError: false },
    });
    await expect(
      handleCodexSlimEditMcpRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "edit",
            arguments: { filePath: "note.txt", oldString: "hello", newString: "next" },
          },
        },
        { root },
      ),
    ).resolves.toMatchObject({
      result: { content: [{ text: "OK note.txt" }], isError: false },
    });
    await expect(
      handleCodexSlimEditMcpRequest(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "edit",
            arguments: { filePath: "note.txt", oldString: "missing", newString: "next" },
          },
        },
        { root },
      ),
    ).resolves.toMatchObject({
      result: {
        content: [{ text: expect.stringContaining("EXACT_MATCH_NOT_FOUND") }],
        isError: true,
      },
    });
  });
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexslimedit-mcp-"));
  temporaryDirectories.push(directory);
  return directory;
}
