import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("lists mandatory read_file and apply_patch contracts", async () => {
    const response = await handleCodexSlimEditMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(response).toMatchObject({
      result: {
        tools: [
          {
            name: "read_file",
            description: expect.stringContaining("Required tool for reading one complete UTF-8"),
            inputSchema: {
              properties: {
                filePath: { description: expect.stringContaining("workspace-relative") },
              },
              required: ["filePath"],
            },
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          {
            name: "apply_patch",
            description: expect.stringContaining("Required workspace write tool"),
            inputSchema: {
              properties: {
                patch: { description: expect.stringContaining("Native Codex patch envelope") },
                filePath: { description: expect.stringContaining("workspace-relative") },
                oldString: { description: expect.stringContaining("unique exact text") },
                newString: { description: expect.stringContaining("Replacement text") },
              },
              oneOf: [
                { required: ["patch"] },
                { required: ["filePath", "oldString", "newString"] },
              ],
            },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
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
        params: { name: "apply_patch", arguments: {} },
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
          params: { name: "read_file", arguments: { filePath: "note.txt" } },
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
            name: "apply_patch",
            arguments: { filePath: "note.txt", oldString: "hello", newString: "next" },
          },
        },
        { root, accessMode: "workspace-write" },
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
            name: "apply_patch",
            arguments: { filePath: "note.txt", oldString: "missing", newString: "next" },
          },
        },
        { root, accessMode: "workspace-write" },
      ),
    ).resolves.toMatchObject({
      result: {
        content: [{ text: expect.stringContaining("EXACT_MATCH_NOT_FOUND") }],
        isError: true,
      },
    });
  });

  it("applies native patch envelopes that add, update, and delete files", async () => {
    const root = await createWorkspace();

    await expect(
      callApplyPatch(root, "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch"),
    ).resolves.toMatchObject({ result: { isError: false } });
    await expect(readFile(join(root, "note.txt"), "utf8")).resolves.toBe("hello\n");

    await expect(
      callApplyPatch(
        root,
        "*** Begin Patch\n*** Update File: note.txt\n@@\n-hello\n+updated\n*** End Patch",
      ),
    ).resolves.toMatchObject({ result: { isError: false } });
    await expect(readFile(join(root, "note.txt"), "utf8")).resolves.toBe("updated\n");

    await expect(
      callApplyPatch(root, "*** Begin Patch\n*** Delete File: note.txt\n*** End Patch"),
    ).resolves.toMatchObject({ result: { isError: false } });
    await expect(readFile(join(root, "note.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("enforces explicit read and write capabilities", async () => {
    const root = await createWorkspace();
    const outside = await createWorkspace();
    const outsidePath = join(outside, "outside.txt");
    await writeFile(join(root, "note.txt"), "inside\n", "utf8");
    await writeFile(outsidePath, "outside\n", "utf8");

    const deniedWrite = await handleCodexSlimEditMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "apply_patch",
          arguments: { filePath: "note.txt", oldString: "inside", newString: "changed" },
        },
      },
      { root },
    );
    expect(deniedWrite).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining("WRITE_ACCESS_DENIED") }],
        isError: true,
      },
    });

    await expect(callReadFile(root, outsidePath, "workspace-write")).resolves.toMatchObject({
      result: {
        content: [{ text: expect.stringContaining("full-access permission is required") }],
        isError: true,
      },
    });
    await expect(callReadFile(root, outsidePath, "full-access")).resolves.toMatchObject({
      result: { content: [{ text: expect.stringContaining("outside\n") }], isError: false },
    });
  });
});

async function callReadFile(
  root: string,
  filePath: string,
  accessMode: "workspace-write" | "full-access",
) {
  return await handleCodexSlimEditMcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_file", arguments: { filePath } },
    },
    { root, accessMode },
  );
}

async function callApplyPatch(root: string, patch: string) {
  return await handleCodexSlimEditMcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "apply_patch", arguments: { patch } },
    },
    { root, accessMode: "workspace-write" },
  );
}

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexslimedit-mcp-"));
  temporaryDirectories.push(directory);
  return directory;
}
