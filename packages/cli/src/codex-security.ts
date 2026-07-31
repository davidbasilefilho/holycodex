import { z } from "zod";

import {
  runManagedProcess,
  type ManagedProcessInput,
  type ManagedProcessResult,
} from "../../mcp-stdio-core/src/process.ts";

const CODEX_SECURITY_PLUGIN = "codex-security@openai-curated";
const CODEX_PLUGIN_TIMEOUT_MS = 20_000;
const MAX_CODEX_OUTPUT_CHARS = 64 * 1024;

const PluginEntrySchema = z.looseObject({
  pluginId: z.string(),
  installed: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const PluginListSchema = z.looseObject({
  installed: z.array(PluginEntrySchema),
  available: z.array(PluginEntrySchema),
});
const PluginAddSchema = z.looseObject({ pluginId: z.string() });

export type CodexSecuritySkipReason =
  | "codex-unavailable"
  | "unauthenticated"
  | "marketplace-unavailable"
  | "plugin-unavailable"
  | "installation-rejected"
  | "timeout"
  | "invalid-response";

export type CodexSecurityInstallResult =
  | { readonly status: "installed" }
  | { readonly status: "already-installed" }
  | { readonly status: "enabled" }
  | { readonly status: "skipped"; readonly reason: CodexSecuritySkipReason };

export type CodexProcessRunner = (input: ManagedProcessInput) => Promise<ManagedProcessResult>;

/** Installs or enables the official Codex Security plugin without failing HolyCodex installation. */
export async function installCodexSecurity(
  runProcess: CodexProcessRunner = runManagedProcess,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexSecurityInstallResult> {
  const listed = await runCodexPlugin(
    runProcess,
    ["plugin", "list", "--available", "--json"],
    platform,
    env,
  );
  const listFailure = externalFailure(listed);
  if (listFailure !== undefined) return listFailure;
  const parsedList = parseJson(listed.stdout, PluginListSchema);
  if (parsedList === undefined) return skipped("invalid-response");

  const installed = parsedList.installed.find(
    (plugin) => plugin.pluginId === CODEX_SECURITY_PLUGIN,
  );
  if (installed?.installed === true && installed.enabled === true)
    return { status: "already-installed" };
  const wasDisabled = installed?.installed === true;
  const available = parsedList.available.some(
    (plugin) => plugin.pluginId === CODEX_SECURITY_PLUGIN,
  );
  if (!wasDisabled && !available) return skipped("plugin-unavailable");

  const added = await runCodexPlugin(
    runProcess,
    ["plugin", "add", CODEX_SECURITY_PLUGIN, "--json"],
    platform,
    env,
  );
  const addFailure = externalFailure(added);
  if (addFailure !== undefined) return addFailure;
  const parsedAdd = parseJson(added.stdout, PluginAddSchema);
  if (parsedAdd?.pluginId !== CODEX_SECURITY_PLUGIN) return skipped("invalid-response");
  return { status: wasDisabled ? "enabled" : "installed" };
}

async function runCodexPlugin(
  runProcess: CodexProcessRunner,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<ManagedProcessResult> {
  try {
    return await runProcess({
      command: "codex",
      args,
      platform,
      timeoutMs: CODEX_PLUGIN_TIMEOUT_MS,
      maxOutputChars: MAX_CODEX_OUTPUT_CHARS,
      env,
    });
  } catch (error) {
    if (!isUnavailableProcessError(error)) throw error;
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      matched: false,
      outputTruncated: false,
      error: "Codex executable unavailable.",
    };
  }
}

function externalFailure(result: ManagedProcessResult): CodexSecurityInstallResult | undefined {
  if (result.timedOut) return skipped("timeout");
  if (result.error !== undefined) return skipped("codex-unavailable");
  if (result.exitCode === 0) return undefined;
  const diagnostic = parseUnknownJson(result.stderr) ?? parseUnknownJson(result.stdout);
  if (diagnostic === undefined) return skipped("invalid-response");
  return skipped(classifyStructuredFailure(diagnostic));
}

function classifyStructuredFailure(value: unknown): CodexSecuritySkipReason {
  const code = structuredErrorCode(value);
  if (code === undefined) return "invalid-response";
  if (["401", "UNAUTHENTICATED", "AUTHENTICATION_REQUIRED"].includes(code))
    return "unauthenticated";
  if (
    [
      "502",
      "503",
      "504",
      "MARKETPLACE_UNAVAILABLE",
      "MARKETPLACE_LOAD_FAILED",
      "CATALOG_UNAVAILABLE",
    ].includes(code)
  )
    return "marketplace-unavailable";
  if (["404", "PLUGIN_NOT_FOUND", "PLUGIN_UNAVAILABLE"].includes(code)) return "plugin-unavailable";
  if (
    [
      "403",
      "INSTALLATION_REJECTED",
      "PERMISSION_DENIED",
      "POLICY_REJECTED",
      "ACCOUNT_RESTRICTED",
    ].includes(code)
  )
    return "installation-rejected";
  return "invalid-response";
}

function structuredErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value.error;
  if (nested !== undefined) {
    const nestedCode = structuredErrorCode(nested);
    if (nestedCode !== undefined) return nestedCode;
  }
  for (const key of ["code", "status", "statusCode"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number")
      return String(candidate).trim().toUpperCase();
  }
  return undefined;
}

function parseJson<TSchema extends z.ZodType>(
  input: string,
  schema: TSchema,
): z.output<TSchema> | undefined {
  const value = parseUnknownJson(input);
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseUnknownJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnavailableProcessError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["EACCES", "ENOENT", "EPERM"].includes(String(value.code).toUpperCase());
}

function skipped(reason: CodexSecuritySkipReason): CodexSecurityInstallResult {
  return { status: "skipped", reason };
}
