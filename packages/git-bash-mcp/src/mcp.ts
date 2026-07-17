import type { Readable, Writable } from "node:stream";

import {
  errorResponse,
  JsonRpcRequestSchema,
  McpToolCallParamsSchema,
  jsonRpcId,
  messageFromError,
  runJsonRpcStdioServer,
  successResponse,
} from "@holycodex/mcp-stdio-core";
import type { JsonRpcResponse, McpLifecycleLog } from "@holycodex/mcp-stdio-core";
import { z } from "zod";

import { VERSION } from "../../cli/src/catalog.ts";
import {
  resolveGitBash,
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "./git-bash-resolver";
import { runGitBashCommand, type RunGitBashCommand } from "./runner";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const SERVER_INSTRUCTIONS =
  "On native Windows, use git_bash.run for every shell command; other shell execution is prohibited. Resolve this server before the first shell action. Use workdir instead of cd. Stop and report a blocker if run is unavailable.";
const EXEC_COMMAND_TIMEOUT_ENV_KEYS = [
  "HOLYCODEX_GIT_BASH_TIMEOUT_MS",
  "HOLYCODEX_EXEC_COMMAND_TIMEOUT_MS",
  "CODEX_EXEC_COMMAND_TIMEOUT_MS",
  "EXEC_COMMAND_TIMEOUT_MS",
] as const;
const InitializeParamsSchema = z.looseObject({ protocolVersion: z.string() });
const TimeoutSchema = z
  .union([z.number(), z.string().trim().min(1).transform(Number)])
  .pipe(z.number().int().min(1).max(MAX_TIMEOUT_MS));
const RunArgumentsSchema = z.strictObject({
  command: z.string().trim().min(1),
  workdir: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  timeout: TimeoutSchema.optional(),
  timeout_ms: TimeoutSchema.optional(),
  description: z.string().optional(),
});

export interface GitBashMcpOptions {
  readonly lifecycleLog?: McpLifecycleLog;
  readonly platform?: string;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly exists?: (path: string) => boolean;
  readonly where?: (command: "bash") => readonly string[];
  readonly runGitBash?: RunGitBashCommand;
  readonly defaultTimeoutMs?: number;
}

export type { JsonRpcResponse };

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Handles git bash mcp request. */
export async function handleGitBashMcpRequest(
  input: unknown,
  options: GitBashMcpOptions = {},
): Promise<JsonRpcResponse | undefined> {
  const request = JsonRpcRequestSchema.safeParse(input);
  if (!request.success) return errorResponse(null, -32600, "Invalid Request");
  const id = jsonRpcId(request.data.id);
  const method = request.data.method;

  if (method === "initialize") {
    const protocolVersion =
      InitializeParamsSchema.safeParse(request.data.params).data?.protocolVersion ?? "2024-11-05";
    return successResponse(id, {
      capabilities: { tools: { listChanged: false } },
      instructions: SERVER_INSTRUCTIONS,
      serverInfo: { name: "git_bash", version: VERSION },
      protocolVersion,
    });
  }

  if (method === "tools/list") return successResponse(id, { tools: toolsForOptions(options) });

  if (method === "tools/call") {
    const params = McpToolCallParamsSchema.safeParse(request.data.params);
    if (!params.success) return toolResponse(id, "Invalid tools/call parameters.", true);
    return await callTool(id, params.data.name, params.data.arguments ?? {}, options);
  }

  if (method === "notifications/initialized") return undefined;

  return errorResponse(id, -32601, "Method not found");
}

/** Runs mcp stdio server. */
export async function runMcpStdioServer(
  input: Readable,
  output: Writable,
  options: GitBashMcpOptions = {},
): Promise<void> {
  if (!canRunGitBash(options)) return;

  await runJsonRpcStdioServer({
    input,
    output,
    handler: handleGitBashMcpRequest,
    handlerOptions: options,
    idleTimeoutMs: 0,
    ...(options.lifecycleLog === undefined ? {} : { log: options.lifecycleLog }),
    parseErrorResponse: () => errorResponse(null, -32601, "Method not found"),
  });
}

async function callTool(
  id: string | number | null,
  name: string,
  args: Record<string, unknown>,
  options: GitBashMcpOptions,
): Promise<JsonRpcResponse> {
  if (name === "which_bash") return toolResponse(id, JSON.stringify(resolve(options), null, 2));
  if (name === "diagnose")
    return toolResponse(id, diagnosePayload(resolve(options), platformFromOptions(options)));
  if (name === "run") return await runToolResponse(id, args, options);
  return toolResponse(id, `Unknown git_bash tool: ${name}`, true);
}

async function runToolResponse(
  id: string | number | null,
  args: Record<string, unknown>,
  options: GitBashMcpOptions,
): Promise<JsonRpcResponse> {
  const platform = platformFromOptions(options);
  if (platform !== "win32")
    return toolResponse(id, "git_bash run is only available on native Windows.", true);

  const parsedArgs = RunArgumentsSchema.safeParse(args);
  if (!parsedArgs.success) {
    const field = parsedArgs.error.issues[0]?.path[0];
    if (field === "workdir" || field === "cwd")
      return toolResponse(id, "run.workdir must be a non-empty string when provided.", true);
    if (field === "timeout" || field === "timeout_ms")
      return toolResponse(
        id,
        `run.timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}.`,
        true,
      );
    return toolResponse(id, "run.command must be a non-empty string.", true);
  }

  const command = parsedArgs.data.command;
  const cwd = parsedArgs.data.workdir ?? parsedArgs.data.cwd;
  const timeoutMs =
    parsedArgs.data.timeout ?? parsedArgs.data.timeout_ms ?? defaultTimeoutMs(options);

  const resolution = resolve(options);
  if (!resolution.found || resolution.path === null)
    return toolResponse(id, JSON.stringify(resolution, null, 2), true);

  try {
    const run = options.runGitBash ?? runGitBashCommand;
    const result = await run({
      bashPath: resolution.path,
      command,
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs,
      env: options.env ?? process.env,
    });
    return toolResponse(id, JSON.stringify(result, null, 2));
  } catch (error) {
    return toolResponse(id, messageFromError(error), true);
  }
}

function toolsForOptions(options: GitBashMcpOptions): ToolDefinition[] {
  const sharedTools: ToolDefinition[] = [
    {
      name: "which_bash",
      description: "Use to find Git Bash on Windows.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "diagnose",
      description: "Use to diagnose Git Bash readiness.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
  if (!canRunGitBash(options)) return sharedTools;
  return [
    {
      name: "run",
      description:
        "Use for every shell command on native Windows, including Git, Bash, POSIX, package, build, test, and script commands; other shell execution is prohibited.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run." },
          timeout: {
            type: "integer",
            minimum: 1,
            maximum: MAX_TIMEOUT_MS,
            description: `Timeout in milliseconds; defaults to inherited exec_command timeout or ${defaultTimeoutMs(options)}ms.`,
          },
          workdir: {
            type: "string",
            description:
              "Working directory. Use this instead of 'cd'. Defaults to current directory.",
          },
          description: {
            type: "string",
            description: "Command purpose in 5-10 words.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    ...sharedTools,
  ];
}

function canRunGitBash(options: GitBashMcpOptions): boolean {
  if (platformFromOptions(options) !== "win32") return false;
  const resolution = resolve(options);
  return resolution.found && resolution.path !== null;
}

function resolve(options: GitBashMcpOptions): GitBashResolution {
  if (options.exists === undefined && options.where === undefined) {
    return resolveGitBashForCurrentProcess({
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  return resolveGitBash({
    platform: platformFromOptions(options),
    env: options.env ?? process.env,
    exists: options.exists ?? (() => false),
    where: options.where ?? (() => []),
  });
}

function platformFromOptions(options: GitBashMcpOptions): string {
  return options.platform ?? process.platform;
}

function diagnosePayload(resolution: GitBashResolution, platform: string): string {
  const enabled = platform === "win32" && resolution.found && resolution.path !== null;
  const payload = {
    platform,
    enabled,
    status:
      platform === "win32"
        ? enabled
          ? "ready"
          : "missing-git-bash"
        : "disabled: git_bash command execution is only exposed on native Windows",
    resolution,
  };
  return JSON.stringify(payload, null, 2);
}

function toolResponse(id: string | number | null, text: string, isError = false): JsonRpcResponse {
  return successResponse(id, { content: [{ type: "text", text }], isError });
}

function defaultTimeoutMs(options: GitBashMcpOptions): number {
  const configured = normalizeTimeoutMs(options.defaultTimeoutMs);
  if (configured !== null) return configured;
  const env = options.env ?? process.env;
  for (const key of EXEC_COMMAND_TIMEOUT_ENV_KEYS) {
    const timeoutMs = normalizeTimeoutMs(env[key]);
    if (timeoutMs !== null) return timeoutMs;
  }
  return DEFAULT_TIMEOUT_MS;
}

function normalizeTimeoutMs(value: unknown): number | null {
  return TimeoutSchema.safeParse(value).data ?? null;
}
