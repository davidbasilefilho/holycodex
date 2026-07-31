import { z } from "zod";

import {
  runManagedProcess,
  type ManagedProcessInput,
  type ManagedProcessResult,
} from "../../mcp-stdio-core/src/process.ts";
import {
  codexLauncherArgs,
  createCodexLauncherCandidates,
  defaultCodexLauncherRuntimeFacts,
  type CodexLauncher,
  type CodexLauncherCandidatesInput,
  type CodexLauncherSource,
} from "./codex-launcher.ts";

const CODEX_SECURITY_PLUGIN = "codex-security@openai-curated";
const CODEX_PLUGIN_OPERATIONAL_TIMEOUT_MS = 15_000;
const CODEX_PACKAGE_BOOTSTRAP_TIMEOUT_MS = 120_000;
const MAX_CODEX_OUTPUT_CHARS = 64 * 1024;
const SPAWN_UNAVAILABLE_CODES = new Set(["EACCES", "ENOENT", "EPERM"]);
const FATAL_AUTH_CODES = new Set(["401", "UNAUTHENTICATED", "AUTHENTICATION_REQUIRED"]);
const FATAL_ACCOUNT_CODES = new Set(["ACCOUNT_REQUIRED", "ACCOUNT_NOT_FOUND"]);
const FATAL_MARKETPLACE_CODES = new Set([
  "502",
  "503",
  "504",
  "MARKETPLACE_UNAVAILABLE",
  "MARKETPLACE_LOAD_FAILED",
  "CATALOG_UNAVAILABLE",
]);
const FATAL_PLUGIN_CODES = new Set(["404", "PLUGIN_NOT_FOUND", "PLUGIN_UNAVAILABLE"]);
const FATAL_POLICY_CODES = new Set([
  "403",
  "ACCOUNT_RESTRICTED",
  "ACCOUNT_UNAVAILABLE",
  "ACCOUNT_SUSPENDED",
  "ACCOUNT_DISABLED",
  "INSTALLATION_REJECTED",
  "PERMISSION_DENIED",
  "POLICY_REJECTED",
]);

const PluginEntrySchema = z.looseObject({
  pluginId: z.string().min(1),
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
  | "invalid-response"
  | "unsupported"
  | "download-failed";

export type CodexSecurityInstallResult =
  | {
      readonly status: "installed";
      readonly launcherSource?: CodexLauncherSource;
    }
  | {
      readonly status: "already-installed";
      readonly launcherSource?: CodexLauncherSource;
    }
  | {
      readonly status: "enabled";
      readonly launcherSource?: CodexLauncherSource;
    }
  | {
      readonly status: "skipped";
      readonly reason: CodexSecuritySkipReason;
      readonly attemptedLaunchers?: readonly CodexLauncherSource[];
    };

export type CodexProcessRunner = (input: ManagedProcessInput) => Promise<ManagedProcessResult>;

/** Runtime facts and deterministic launchers for Codex Security installation. */
export type CodexSecurityInstallOptions = CodexLauncherCandidatesInput;

export const CODEX_OPERATIONAL_TIMEOUT_MS = CODEX_PLUGIN_OPERATIONAL_TIMEOUT_MS;
export const CODEX_BOOTSTRAP_TIMEOUT_MS = CODEX_PACKAGE_BOOTSTRAP_TIMEOUT_MS;

/** Installs or enables the official Codex Security plugin without failing HolyCodex installation. */
export async function installCodexSecurity(
  runProcess: CodexProcessRunner = runManagedProcess,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options: CodexSecurityInstallOptions = {},
): Promise<CodexSecurityInstallResult> {
  const runtimeFacts =
    options.runtimeFacts ??
    (runProcess === runManagedProcess ? defaultCodexLauncherRuntimeFacts(platform) : undefined);
  const candidates = createCodexLauncherCandidates({
    ...(options.injected === undefined ? {} : { injected: options.injected }),
    ...(runtimeFacts === undefined ? {} : { runtimeFacts }),
  });
  const attemptedLaunchers: CodexLauncherSource[] = [];
  const fallbackReasons: CodexSecuritySkipReason[] = [];

  for (const launcher of candidates) {
    attemptedLaunchers.push(launcher.source);
    const listed = await runCodexPlugin(
      runProcess,
      launcher,
      ["plugin", "list", "--available", "--json"],
      platform,
      env,
      "list",
    );
    const listOutcome = inspectListResult(listed, launcher);
    if (listOutcome.kind === "fallback") {
      fallbackReasons.push(listOutcome.reason);
      continue;
    }
    if (listOutcome.kind === "fatal") return skipped(listOutcome.reason, attemptedLaunchers);

    const installed = listOutcome.catalog.installed.find(
      (plugin) => plugin.pluginId === CODEX_SECURITY_PLUGIN,
    );
    const available = listOutcome.catalog.available.find(
      (plugin) => plugin.pluginId === CODEX_SECURITY_PLUGIN,
    );
    if (installed?.installed === true && installed.enabled === true)
      return { status: "already-installed", launcherSource: launcher.source };
    const wasDisabled = installed?.installed === true;
    const selectedPluginId = installed?.pluginId ?? available?.pluginId;
    if (!wasDisabled && selectedPluginId === undefined)
      return skipped("plugin-unavailable", attemptedLaunchers);
    if (selectedPluginId === undefined) return skipped("invalid-response", attemptedLaunchers);

    const added = await runCodexPlugin(
      runProcess,
      launcher,
      ["plugin", "add", selectedPluginId, "--json"],
      platform,
      env,
      "add",
    );
    return inspectAddResult(added, launcher, selectedPluginId, wasDisabled, attemptedLaunchers);
  }

  return skipped(finalFallbackReason(fallbackReasons), attemptedLaunchers);
}

type PluginCatalog = z.output<typeof PluginListSchema>;
type ProbeOutcome =
  | { readonly kind: "selected"; readonly catalog: PluginCatalog }
  | { readonly kind: "fallback"; readonly reason: CodexSecuritySkipReason }
  | { readonly kind: "fatal"; readonly reason: CodexSecuritySkipReason };

async function runCodexPlugin(
  runProcess: CodexProcessRunner,
  launcher: CodexLauncher,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  operation: "list" | "add",
): Promise<ManagedProcessResult> {
  try {
    return await runProcess({
      command: launcher.command,
      args: codexLauncherArgs(launcher, args),
      platform,
      timeoutMs: timeoutFor(launcher, operation),
      maxOutputChars: MAX_CODEX_OUTPUT_CHARS,
      env,
    });
  } catch (error) {
    const code = thrownErrorCode(error);
    if (
      !isUnavailableThrownError(error) &&
      !(isPackageLauncher(launcher) && isBootstrapThrownError(error))
    )
      throw error;
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      matched: false,
      outputTruncated: false,
      error: "Codex launcher could not be started.",
      ...(code === undefined ? {} : { errorCode: code }),
    };
  }
}

function inspectListResult(result: ManagedProcessResult, launcher: CodexLauncher): ProbeOutcome {
  if (result.timedOut)
    return launcher.source === "path"
      ? { kind: "fatal", reason: "timeout" }
      : { kind: "fallback", reason: "timeout" };
  const failure = classifyFailure(result, launcher, "list");
  if (failure !== undefined) return failure;
  const catalog = parseJson(result.stdout, PluginListSchema);
  if (catalog === undefined) return { kind: "fatal", reason: "invalid-response" };
  return { kind: "selected", catalog };
}

function inspectAddResult(
  result: ManagedProcessResult,
  launcher: CodexLauncher,
  selectedPluginId: string,
  wasDisabled: boolean,
  attemptedLaunchers: readonly CodexLauncherSource[],
): CodexSecurityInstallResult {
  if (result.timedOut) return skipped("timeout", attemptedLaunchers);
  const failure = classifyFailure(result, launcher, "add");
  if (failure !== undefined) return skipped(failure.reason, attemptedLaunchers);
  const parsedAdd = parseJson(result.stdout, PluginAddSchema);
  if (parsedAdd?.pluginId !== selectedPluginId)
    return skipped("invalid-response", attemptedLaunchers);
  return {
    status: wasDisabled ? "enabled" : "installed",
    launcherSource: launcher.source,
  };
}

function classifyFailure(
  result: ManagedProcessResult,
  launcher: CodexLauncher,
  operation: "list" | "add",
): Exclude<ProbeOutcome, { readonly kind: "selected" }> | undefined {
  if (result.error !== undefined) {
    if (isUnavailableProcessError(result)) return { kind: "fallback", reason: "codex-unavailable" };
    return {
      kind: operation === "list" && isPackageLauncher(launcher) ? "fallback" : "fatal",
      reason:
        operation === "list" && isPackageLauncher(launcher)
          ? "download-failed"
          : "invalid-response",
    };
  }
  if (result.exitCode === 0) return undefined;
  const diagnosticValue = parseUnknownJson(result.stderr) ?? parseUnknownJson(result.stdout);
  const code = structuredErrorCode(diagnosticValue);
  const text = sanitizeDiagnostic(result.stderr);
  const failureReason = classifyFailureReason(code, text);
  if (failureReason === "unsupported" || failureReason === "download-failed") {
    if (failureReason === "download-failed" && launcher.source === "path")
      return { kind: "fatal", reason: "marketplace-unavailable" };
    return operation === "list" && isPackageLauncher(launcher)
      ? { kind: "fallback", reason: failureReason }
      : failureReason === "unsupported"
        ? { kind: "fallback", reason: "unsupported" }
        : { kind: "fatal", reason: "invalid-response" };
  }
  if (failureReason === "codex-unavailable") return { kind: "fallback", reason: failureReason };
  return { kind: "fatal", reason: failureReason };
}

function classifyFailureReason(
  code: string | undefined,
  diagnostic: string,
): CodexSecuritySkipReason {
  if (code !== undefined) {
    if (FATAL_AUTH_CODES.has(code) || FATAL_ACCOUNT_CODES.has(code)) return "unauthenticated";
    if (FATAL_MARKETPLACE_CODES.has(code)) return "marketplace-unavailable";
    if (FATAL_PLUGIN_CODES.has(code)) return "plugin-unavailable";
    if (FATAL_POLICY_CODES.has(code)) return "installation-rejected";
    if (SPAWN_UNAVAILABLE_CODES.has(code)) return "codex-unavailable";
    if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code))
      return "download-failed";
  }
  const lower = diagnostic.toLowerCase();
  if (
    /unknown (?:command|subcommand)|unrecognized (?:command|subcommand)|invalid subcommand/.test(
      lower,
    )
  )
    return "unsupported";
  if (
    /not supported on (?:this )?platform|unsupported (?:platform|architecture)|no matching (?:binary|package)|platform package|not compatible/.test(
      lower,
    )
  )
    return "unsupported";
  if (/eai_again|enetwork|network|timed out|timeout|download|fetch|resolve package/.test(lower))
    return "download-failed";
  if (
    /unauthenticated|authentication required|not logged in|account (?:required|not found)/.test(
      lower,
    )
  )
    return "unauthenticated";
  if (/account (?:restricted|unavailable|suspended|disabled)/.test(lower))
    return "installation-rejected";
  if (/marketplace|catalog/.test(lower)) return "marketplace-unavailable";
  if (/plugin (?:not found|unavailable|missing)/.test(lower)) return "plugin-unavailable";
  if (/permission denied|policy|rejected|forbidden/.test(lower)) return "installation-rejected";
  return "invalid-response";
}

function finalFallbackReason(reasons: readonly CodexSecuritySkipReason[]): CodexSecuritySkipReason {
  if (reasons.includes("timeout")) return "timeout";
  if (reasons.includes("unsupported")) return "unsupported";
  if (reasons.includes("download-failed")) return "download-failed";
  return "codex-unavailable";
}

function timeoutFor(launcher: CodexLauncher, operation: "list" | "add"): number {
  return operation === "list" && isPackageLauncher(launcher)
    ? CODEX_PACKAGE_BOOTSTRAP_TIMEOUT_MS
    : CODEX_PLUGIN_OPERATIONAL_TIMEOUT_MS;
}

function isPackageLauncher(launcher: CodexLauncher): boolean {
  return (
    launcher.source === "bunx" || launcher.source === "npm-exec" || launcher.source === "pnpm-exec"
  );
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

function structuredErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.error !== undefined) {
    const nestedCode = structuredErrorCode(value.error);
    if (nestedCode !== undefined) return nestedCode;
  }
  for (const key of ["code", "status", "statusCode"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number")
      return String(candidate).trim().toUpperCase();
  }
  return undefined;
}

function sanitizeDiagnostic(input: string): string {
  return input
    .replaceAll(/(?:[A-Za-z]:)?[\\/][^\s"']+/g, "<path>")
    .replaceAll(/(token|secret|password|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1=<redacted>")
    .slice(0, 2_048);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnavailableProcessError(result: ManagedProcessResult): boolean {
  if (result.errorCode !== undefined && SPAWN_UNAVAILABLE_CODES.has(result.errorCode.toUpperCase()))
    return true;
  const error = result.error?.toUpperCase() ?? "";
  return [...SPAWN_UNAVAILABLE_CODES].some((code) =>
    new RegExp(`(?:^|\\s)${code}(?:$|\\s)`).test(error),
  );
}

function isUnavailableThrownError(value: unknown): boolean {
  const code = thrownErrorCode(value);
  return code !== undefined && SPAWN_UNAVAILABLE_CODES.has(code.toUpperCase());
}

function isBootstrapThrownError(value: unknown): boolean {
  const code = thrownErrorCode(value)?.toUpperCase();
  if (
    code !== undefined &&
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code)
  )
    return true;
  if (!(value instanceof Error)) return false;
  return /bootstrap|network|download|fetch|timeout|timed out/i.test(value.message);
}

function thrownErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  const code = value.code;
  return typeof code === "string" ? code : undefined;
}

function skipped(
  reason: CodexSecuritySkipReason,
  attemptedLaunchers: readonly CodexLauncherSource[],
): CodexSecurityInstallResult {
  return { status: "skipped", reason, attemptedLaunchers: [...attemptedLaunchers] };
}
