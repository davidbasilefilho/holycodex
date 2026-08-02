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

    const plugin = listOutcome.catalog.plugins.find(({ id }) => id === CODEX_SECURITY_PLUGIN);
    if (plugin?.installed === true && plugin.enabled === true)
      return { status: "already-installed", launcherSource: launcher.source };
    const wasDisabled = plugin?.installed === true;

    const added = await runCodexPlugin(
      runProcess,
      launcher,
      ["plugin", "add", CODEX_SECURITY_PLUGIN, "--json"],
      platform,
      env,
      "add",
    );
    const addOutcome = inspectAddResult(added, launcher);
    if (addOutcome.kind === "fallback") {
      fallbackReasons.push(addOutcome.reason);
      continue;
    }
    if (addOutcome.kind === "fatal") return skipped(addOutcome.reason, attemptedLaunchers);

    const verified = await runCodexPlugin(
      runProcess,
      launcher,
      ["plugin", "list", "--available", "--json"],
      platform,
      env,
      "list",
    );
    const verification = inspectListResult(verified, launcher);
    if (verification.kind === "fallback") {
      fallbackReasons.push(verification.reason);
      continue;
    }
    if (verification.kind === "fatal") return skipped(verification.reason, attemptedLaunchers);
    const verifiedPlugin = verification.catalog.plugins.find(
      ({ id }) => id === CODEX_SECURITY_PLUGIN,
    );
    if (verifiedPlugin?.installed !== true || verifiedPlugin.enabled !== true) {
      fallbackReasons.push("plugin-unavailable");
      continue;
    }
    return {
      status: wasDisabled ? "enabled" : "installed",
      launcherSource: launcher.source,
    };
  }

  return skipped(finalFallbackReason(fallbackReasons), attemptedLaunchers);
}

type PluginState = {
  readonly id: string;
  readonly installed: boolean;
  readonly enabled: boolean;
};
type PluginCatalog = { readonly plugins: readonly PluginState[] };
type ProbeOutcome =
  | { readonly kind: "selected"; readonly catalog: PluginCatalog }
  | { readonly kind: "fallback"; readonly reason: CodexSecuritySkipReason }
  | { readonly kind: "fatal"; readonly reason: CodexSecuritySkipReason };
type AddOutcome = Exclude<ProbeOutcome, { readonly kind: "selected" }> | { readonly kind: "added" };

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
  if (result.timedOut) return { kind: "fallback", reason: "timeout" };
  const failure = classifyFailure(result, launcher);
  if (failure !== undefined) return failure;
  const catalog = parsePluginCatalog(result.stdout);
  if (catalog === undefined) return { kind: "fallback", reason: "invalid-response" };
  return { kind: "selected", catalog };
}

function inspectAddResult(result: ManagedProcessResult, launcher: CodexLauncher): AddOutcome {
  if (result.timedOut) return { kind: "fallback", reason: "timeout" };
  const failure = classifyFailure(result, launcher);
  if (failure !== undefined) return failure;
  if (!isRecord(parseUnknownJson(result.stdout)))
    return { kind: "fallback", reason: "invalid-response" };
  return { kind: "added" };
}

function classifyFailure(
  result: ManagedProcessResult,
  launcher: CodexLauncher,
): Exclude<ProbeOutcome, { readonly kind: "selected" }> | undefined {
  if (result.error !== undefined) {
    if (isUnavailableProcessError(result)) return { kind: "fallback", reason: "codex-unavailable" };
    return {
      kind: "fallback",
      reason: isPackageLauncher(launcher) ? "download-failed" : "invalid-response",
    };
  }
  if (result.exitCode === 0) return undefined;
  const diagnosticValue = parseUnknownJson(result.stderr) ?? parseUnknownJson(result.stdout);
  const code = structuredErrorCode(diagnosticValue);
  const text = sanitizeDiagnostic(result.stderr);
  const failureReason = classifyFailureReason(code, text);
  if (failureReason === "unauthenticated" || failureReason === "installation-rejected")
    return { kind: "fatal", reason: failureReason };
  return { kind: "fallback", reason: failureReason };
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
  if (
    /unauthenticated|authentication required|not logged in|account (?:required|not found)/.test(
      lower,
    )
  )
    return "unauthenticated";
  if (/account (?:restricted|unavailable|suspended|disabled)/.test(lower))
    return "installation-rejected";
  if (/marketplace|catalog/.test(lower)) return "marketplace-unavailable";
  if (/eai_again|enetwork|network|timed out|timeout|download|fetch|resolve package/.test(lower))
    return "download-failed";
  if (/plugin (?:not found|unavailable|missing)/.test(lower)) return "plugin-unavailable";
  if (/permission denied|policy|rejected|forbidden/.test(lower)) return "installation-rejected";
  return "invalid-response";
}

function finalFallbackReason(reasons: readonly CodexSecuritySkipReason[]): CodexSecuritySkipReason {
  if (reasons.includes("timeout")) return "timeout";
  if (reasons.includes("unsupported")) return "unsupported";
  if (reasons.includes("download-failed")) return "download-failed";
  if (reasons.includes("marketplace-unavailable")) return "marketplace-unavailable";
  if (reasons.includes("plugin-unavailable")) return "plugin-unavailable";
  if (reasons.includes("invalid-response")) return "invalid-response";
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

/** Normalizes supported flat and marketplace-oriented Codex catalogs. */
function parsePluginCatalog(input: string): PluginCatalog | undefined {
  const value = parseUnknownJson(input);
  if (value === undefined) return undefined;
  const plugins = parseCatalogValue(value);
  return plugins === undefined ? undefined : { plugins };
}

function parseCatalogValue(value: unknown): readonly PluginState[] | undefined {
  if (Array.isArray(value)) return parseMarketplaceEntries(value);
  if (!isRecord(value)) return undefined;
  if ("installed" in value || "available" in value) {
    if (!Array.isArray(value.installed) || !Array.isArray(value.available)) return undefined;
    const installed = parsePluginEntries(value.installed, undefined, true);
    const available = parsePluginEntries(value.available, undefined, false);
    return installed === undefined || available === undefined
      ? undefined
      : [...installed, ...available];
  }
  if ("marketplaces" in value) {
    return Array.isArray(value.marketplaces)
      ? parseMarketplaceEntries(value.marketplaces)
      : undefined;
  }
  if ("plugins" in value) return parseMarketplaceEntry(value);
  return undefined;
}

function parseMarketplaceEntries(entries: readonly unknown[]): readonly PluginState[] | undefined {
  const plugins: PluginState[] = [];
  for (const entry of entries) {
    const parsed = parseMarketplaceEntry(entry);
    if (parsed === undefined) return undefined;
    plugins.push(...parsed);
  }
  return plugins;
}

function parseMarketplaceEntry(value: unknown): readonly PluginState[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.plugins)) return undefined;
  const marketplace = stringField(value, [
    "marketplace",
    "marketplaceId",
    "marketplaceName",
    "id",
    "name",
  ]);
  if (marketplace === undefined) return undefined;
  return parsePluginEntries(value.plugins, marketplace);
}

function parsePluginEntries(
  entries: readonly unknown[],
  parentMarketplace?: string,
  defaultInstalled?: boolean,
): readonly PluginState[] | undefined {
  const plugins: PluginState[] = [];
  for (const value of entries) {
    const plugin = parsePluginEntry(value, parentMarketplace, defaultInstalled);
    if (plugin === undefined) return undefined;
    plugins.push(plugin);
  }
  return plugins;
}

function parsePluginEntry(
  value: unknown,
  parentMarketplace?: string,
  defaultInstalled = false,
): PluginState | undefined {
  if (!isRecord(value)) return undefined;
  const rawId = stringField(value, ["pluginId", "id", "name"]);
  if (rawId === undefined) return undefined;
  const marketplace =
    stringField(value, ["marketplace", "marketplaceId", "marketplaceName"]) ?? parentMarketplace;
  const id = rawId.includes("@")
    ? rawId
    : marketplace === undefined
      ? rawId
      : `${rawId}@${marketplace}`;
  const state = stringField(value, ["installationState", "installState", "status", "state"]);
  const policy = isRecord(value.policy) ? stringField(value.policy, ["installation"]) : undefined;
  const installed =
    booleanField(value.installed) ?? installedFromState(state ?? policy) ?? defaultInstalled;
  const enabled = booleanField(value.enabled) ?? enabledFromState(state) ?? false;
  return { id, installed, enabled };
}

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return undefined;
}

function booleanField(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

function installedFromState(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const state = value.toLowerCase().replaceAll("-", "_");
  if (["installed", "enabled", "disabled", "installed_by_default"].includes(state)) return true;
  if (["available", "not_installed", "uninstalled", "not_available"].includes(state)) return false;
  return undefined;
}

function enabledFromState(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const state = value.toLowerCase();
  if (state === "enabled") return true;
  if (state === "disabled") return false;
  return undefined;
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
