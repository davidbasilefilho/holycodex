import { type RequestContext, runWithRequestContext } from "@holycodex/lsp-core/request-context";
import { executeLspTool, type ToolExecutionResult } from "@holycodex/lsp-core/tools";
import { z } from "zod";

export const CONTEXT_KEY = "_context";
const RequestContextSchema = z
  .strictObject({
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => value.cwd !== undefined || value.env !== undefined);
const DaemonRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.literal("lsp/call"),
  params: z.object({
    command: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type DaemonResponse = { readonly id: string | number; readonly result: ToolExecutionResult };

export interface RoutedRequest {
  input: unknown;
  context: RequestContext | undefined;
}

/** Extracts request context. */
export function extractRequestContext(raw: unknown): RoutedRequest {
  const request = DaemonRequestSchema.safeParse(raw);
  if (!request.success) return { input: raw, context: undefined };
  const args = request.data.params.arguments ?? {};
  const context = parseContext(args[CONTEXT_KEY]);
  if (!context) return { input: raw, context: undefined };

  const cleanedArgs: Record<string, unknown> = { ...args };
  delete cleanedArgs[CONTEXT_KEY];
  const cleaned = {
    ...request.data,
    params: { ...request.data.params, arguments: cleanedArgs },
  };
  return { input: cleaned, context };
}

/** Handles daemon message. */
export async function handleDaemonMessage(raw: unknown): Promise<DaemonResponse | undefined> {
  const { input, context } = extractRequestContext(raw);
  const request = DaemonRequestSchema.safeParse(input);
  if (!request.success) return undefined;
  const execute = () =>
    executeLspTool(request.data.params.command, request.data.params.arguments ?? {});
  const result = context ? await runWithRequestContext(context, execute) : await execute();
  return { id: request.data.id, result };
}

function parseContext(value: unknown): RequestContext | undefined {
  const parsed = RequestContextSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    ...(parsed.data.cwd === undefined ? {} : { cwd: parsed.data.cwd }),
    ...(parsed.data.env === undefined ? {} : { env: parsed.data.env }),
  };
}
