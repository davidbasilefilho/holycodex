import { z } from "zod";

/** Schema for JSON object values crossing protocol boundaries. */
export const UnknownRecordSchema = z.record(z.string(), z.unknown());

/** Schema for JSON-RPC request identifiers. */
export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

/** Schema for a JSON-RPC request envelope. */
export const JsonRpcRequestSchema = z.looseObject({
  jsonrpc: z.literal("2.0").optional(),
  id: JsonRpcIdSchema.optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

/** Schema for MCP tool call parameters. */
export const McpToolCallParamsSchema = z.looseObject({
  name: z.string(),
  arguments: UnknownRecordSchema.optional(),
});

/** Schema for MCP text content. */
export const TextContentSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

/** Schema for an MCP tool result consumed from another process. */
export const McpToolResultSchema = z.looseObject({
  content: z.array(TextContentSchema),
  isError: z.boolean().optional(),
});
