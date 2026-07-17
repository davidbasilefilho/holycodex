import { JsonRpcIdSchema } from "./schemas.js";
import type { JsonRpcId, JsonRpcResponse, JsonRpcResult } from "./types.js";

/** Creates a successful JSON-RPC response. */
export function successResponse(id: JsonRpcId, result: JsonRpcResult): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Creates an error JSON-RPC response. */
export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/** Parses a JSON-RPC request ID. */
export function jsonRpcId(value: unknown): JsonRpcId {
  return JsonRpcIdSchema.safeParse(value).data ?? null;
}

/** Extracts a message from an unknown error. */
export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extracts the best diagnostic text from an unknown error. */
export function stackOrMessageFromError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
