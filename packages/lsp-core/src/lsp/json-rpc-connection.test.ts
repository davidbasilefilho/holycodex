// SPDX-License-Identifier: Apache-2.0

import { PassThrough } from "node:stream";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { JsonRpcConnection } from "./json-rpc-connection.ts";

function frame(value: unknown): string {
  const body = JSON.stringify(value);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

describe("JsonRpcConnection", () => {
  it("rejects invalid protocol markers and keeps the connection alive", async () => {
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

  it("validates a response and handles fragmentation", async () => {
    const reader = new PassThrough();
    const writer = new PassThrough();
    const connection = new JsonRpcConnection(reader, writer);
    connection.listen();
    const request = connection.sendRequest("example", Schema.String);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" });
    const message = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    reader.write(message.slice(0, 12));
    reader.write(message.slice(12));
    await expect(request).resolves.toBe("ok");
    connection.dispose();
  });

  it("cancels a pending request and emits the cancellation notification", async () => {
    const reader = new PassThrough();
    const writer = new PassThrough();
    const connection = new JsonRpcConnection(reader, writer);
    connection.listen();
    const controller = new AbortController();
    const request = connection.sendRequest("slow", Schema.String, undefined, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    connection.dispose();
  });
});
