import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { JsonRpcConnection } from "./json-rpc-connection";

function frame(value: unknown): string {
  const body = JSON.stringify(value);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

describe("JsonRpcConnection", () => {
  it("rejects a record without the JSON-RPC protocol marker", async () => {
    const reader = new PassThrough();
    const writer = new PassThrough();
    const connection = new JsonRpcConnection(reader, writer);
    connection.listen();
    const response = new Promise<string>((resolve) =>
      writer.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))),
    );

    reader.write(frame({ id: 1, method: "example" }));

    await expect(response).resolves.toContain('"code":-32600');
    connection.dispose();
  });
});
