import { runManagedProcess } from "../../mcp-stdio-core/src/process.ts";

const PACKAGE_INSTALL_TIMEOUT_MS = 120_000;
const PACKAGE_INSTALL_OUTPUT_LIMIT = 4_000;

/** Package runner used to invoke and pre-resolve npm executables. */
export type PackageRunner = "bun" | "npm";

/** Direct executable invocation for codexslimedit. */
export type PackageInvocation = {
  readonly command: "bunx" | "npx" | "npx.cmd";
  readonly args: readonly string[];
};

/** Input used to invoke the matching CodexSlimEdit distribution channel. */
export type CodexSlimEditInvocationInput = {
  /** Package manager that installed HolyCodex. */
  readonly packageRunner: PackageRunner;
  /** Target platform that resolves the executable command. */
  readonly platform: NodeJS.Platform;
  /** Installed HolyCodex version selecting stable or development channel. */
  readonly packageVersion: string;
  /** Whether to append CodexSlimEdit's version flag. */
  readonly includeVersion?: boolean;
  /** Filesystem capability explicitly granted to CodexSlimEdit. */
  readonly accessMode?: "workspace-write" | "full-access";
};

/** Detects whether Bun or npm invoked HolyCodex. */
export function detectPackageRunner(env: NodeJS.ProcessEnv = process.env): PackageRunner {
  const executable = (env.npm_execpath ?? "")
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  const userAgent = env.npm_config_user_agent?.trim().split(/[\s/]/, 1)[0]?.toLowerCase();
  return executable === "bun" || userAgent === "bun" ? "bun" : "npm";
}

/** Builds the runner-specific codexslimedit invocation. */
export function codexSlimEditInvocation(input: CodexSlimEditInvocationInput): PackageInvocation {
  const packageSpec = input.packageVersion.includes("-dev.")
    ? "codexslimedit@dev"
    : "codexslimedit@latest";
  const args = [
    packageSpec,
    ...(input.includeVersion ? ["--version"] : []),
    ...(input.accessMode === undefined ? [] : [`--${input.accessMode}`]),
  ];
  return input.packageRunner === "bun"
    ? { command: "bunx", args }
    : { command: input.platform === "win32" ? "npx.cmd" : "npx", args: ["--yes", ...args] };
}

/** Pre-resolves codexslimedit through the invoking package runner. */
export async function installCodexSlimEdit(
  input: Omit<CodexSlimEditInvocationInput, "includeVersion">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.NODE_ENV === "test" && env.HOLYCODEX_TEST_SKIP_PACKAGE_RESOLUTION === "1") return;
  const invocation = codexSlimEditInvocation({ ...input, includeVersion: true });
  const result = await runManagedProcess({
    ...invocation,
    platform: input.platform,
    timeoutMs: PACKAGE_INSTALL_TIMEOUT_MS,
    maxOutputChars: PACKAGE_INSTALL_OUTPUT_LIMIT,
  });
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail =
    result.error ?? (result.stderr.trim() || result.stdout.trim() || "unknown package error");
  throw new Error(
    `Could not install codexslimedit with ${invocation.command}: ${detail}. Check package registry and network access, then retry HolyCodex installation.`,
  );
}
