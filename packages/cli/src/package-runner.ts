import { runManagedProcess } from "../../mcp-stdio-core/src/process.ts";

const PACKAGE_INSTALL_TIMEOUT_MS = 120_000;
const PACKAGE_INSTALL_OUTPUT_LIMIT = 4_000;

/** Package runner used to invoke and pre-resolve npm executables. */
export type PackageRunner = "bun" | "npm";

/** Direct executable invocation for codexslimedit. */
export type PackageInvocation = {
  readonly command: "bunx" | "npx";
  readonly args: readonly string[];
};

/** Detects whether Bun or npm invoked HolyCodex. */
export function detectPackageRunner(env: NodeJS.ProcessEnv = process.env): PackageRunner {
  const evidence = `${env.npm_execpath ?? ""} ${env.npm_config_user_agent ?? ""}`.toLowerCase();
  return evidence.includes("bun") ? "bun" : "npm";
}

/** Builds the runner-specific codexslimedit invocation. */
export function codexSlimEditInvocation(
  runner: PackageRunner,
  versionOnly: boolean,
): PackageInvocation {
  const args = ["codexslimedit@latest", ...(versionOnly ? ["--version"] : [])];
  return runner === "bun"
    ? { command: "bunx", args }
    : { command: "npx", args: ["--yes", ...args] };
}

/** Pre-resolves codexslimedit through the invoking package runner. */
export async function installCodexSlimEdit(
  runner: PackageRunner,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.NODE_ENV === "test" && env.HOLYCODEX_TEST_SKIP_PACKAGE_RESOLUTION === "1") return;
  const invocation = codexSlimEditInvocation(runner, true);
  const result = await runManagedProcess({
    ...invocation,
    platform,
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
