// HolyCodex does not declare a compatible Codex CLI dependency, so ephemeral runners use the
// current official CLI that provides the plugin commands verified during launcher selection.
const CODEX_PACKAGE_SPEC = "@openai/codex@latest";

/** Safe labels used in installer diagnostics. */
export type CodexLauncherSource = "injected" | "path" | "bunx" | "npm-exec" | "pnpm-exec";

/** A shell-free Codex command and immutable argument prefix. */
export type CodexLauncher = {
  readonly command: string;
  readonly argsPrefix: readonly string[];
  readonly source: CodexLauncherSource;
};

export type CodexLauncherInput = CodexLauncher | string;

/** Process facts used to construct the default launcher candidates. */
export type CodexLauncherRuntimeFacts = {
  readonly allowPackageResolution?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
  readonly runtime?: "bun" | "node";
  readonly pathCodex?: string;
  readonly npmExecPath?: string;
  readonly npm?: string | boolean;
  readonly pnpm?: string | boolean;
  readonly availableRunners?: readonly ("npm" | "pnpm")[];
  readonly nodeRunner?: CodexLauncherInput;
};

/** Inputs for deterministic candidate construction. */
export type CodexLauncherCandidatesInput = {
  readonly injected?: readonly CodexLauncherInput[] | CodexLauncherInput;
  readonly runtimeFacts?: CodexLauncherRuntimeFacts;
};

/** The exact package specifier used by ephemeral package runners. */
export const CODEX_LATEST_PACKAGE = CODEX_PACKAGE_SPEC;

/** Derives safe process facts for the default installation flow. */
export function defaultCodexLauncherRuntimeFacts(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CodexLauncherRuntimeFacts {
  const bun = typeof process.versions.bun === "string";
  const allowPackageResolution = env.HOLYCODEX_TEST_SKIP_PACKAGE_RESOLUTION !== "1";
  const npmExecPath = bun ? undefined : env.npm_execpath;
  return {
    allowPackageResolution,
    platform,
    execPath: process.execPath,
    runtime: bun ? "bun" : "node",
    ...(npmExecPath === undefined ? {} : { npmExecPath }),
    availableRunners: ["npm", "pnpm"],
    npm: platform === "win32" ? "npm.cmd" : "npm",
    pnpm: platform === "win32" ? "pnpm.cmd" : "pnpm",
  };
}

/** Builds ordered Codex launcher candidates once for an installation. */
export function createCodexLauncherCandidates(
  input: CodexLauncherCandidatesInput = {},
): readonly CodexLauncher[] {
  const facts = input.runtimeFacts ?? {};
  const candidates: CodexLauncher[] = [];
  const injected = input.injected === undefined ? [] : toArray(input.injected);
  for (const candidate of injected) {
    const launcher = normalizeLauncher(candidate, "injected");
    if (launcher !== undefined) candidates.push(launcher);
  }

  const pathLauncher = normalizeLauncher(facts.pathCodex ?? "codex", "path");
  if (pathLauncher !== undefined) candidates.push(pathLauncher);

  if (facts.allowPackageResolution === false) return deduplicate(candidates);

  const runtime = facts.runtime ?? (typeof process.versions.bun === "string" ? "bun" : "node");
  if (runtime === "bun") {
    const bunLauncher = normalizeLauncher(
      {
        command: facts.execPath ?? process.execPath,
        argsPrefix: ["x", CODEX_PACKAGE_SPEC],
        source: "bunx",
      },
      "bunx",
    );
    if (bunLauncher !== undefined) candidates.push(bunLauncher);
  }

  const nodeRunner = facts.nodeRunner ?? activeNodeRunner(facts);
  if (nodeRunner !== undefined) {
    const launcher = normalizeLauncher(nodeRunner, nodeRunnerSource(nodeRunner));
    if (launcher !== undefined) candidates.push(launcher);
  }

  const availableRunners = facts.availableRunners ?? [];
  if (facts.npm !== false && (facts.npm !== undefined || availableRunners.includes("npm")))
    candidates.push(packageLauncher(facts.npm, facts.platform, "npm-exec"));
  if (facts.pnpm !== false && (facts.pnpm !== undefined || availableRunners.includes("pnpm")))
    candidates.push(packageLauncher(facts.pnpm, facts.platform, "pnpm-exec"));

  return deduplicate(candidates);
}

/** Appends command arguments to a launcher prefix without mutating either array. */
export function codexLauncherArgs(
  launcher: CodexLauncher,
  args: readonly string[],
): readonly string[] {
  return [...launcher.argsPrefix, ...args];
}

function activeNodeRunner(facts: CodexLauncherRuntimeFacts): CodexLauncherInput | undefined {
  if (facts.npmExecPath === undefined || facts.execPath === undefined) return undefined;
  const source = packageRunnerSource(facts.npmExecPath);
  if (source === undefined) return undefined;
  return {
    command: facts.execPath,
    argsPrefix:
      source === "npm-exec"
        ? [facts.npmExecPath, "exec", "--yes", "--package", CODEX_PACKAGE_SPEC, "--", "codex"]
        : [facts.npmExecPath, "dlx", CODEX_PACKAGE_SPEC],
    source,
  };
}

function packageRunnerSource(path: string): "npm-exec" | "pnpm-exec" | undefined {
  const basename = path.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
  if (["npm", "npm.cmd", "npm-cli.js", "npm-cli.cjs"].includes(basename)) return "npm-exec";
  if (["pnpm", "pnpm.cmd", "pnpm.js", "pnpm.cjs"].includes(basename)) return "pnpm-exec";
  return undefined;
}

function nodeRunnerSource(value: CodexLauncherInput): CodexLauncherSource {
  if (typeof value === "object" && value !== null && "source" in value) {
    if (value.source === "pnpm-exec") return "pnpm-exec";
    if (value.source === "npm-exec") return "npm-exec";
  }
  return "npm-exec";
}

function packageLauncher(
  command: string | boolean | undefined,
  platform: NodeJS.Platform | undefined,
  source: "npm-exec" | "pnpm-exec",
): CodexLauncher {
  const executable =
    typeof command === "string"
      ? command
      : source === "npm-exec"
        ? platform === "win32"
          ? "npm.cmd"
          : "npm"
        : platform === "win32"
          ? "pnpm.cmd"
          : "pnpm";
  return {
    command: executable,
    argsPrefix:
      source === "npm-exec"
        ? ["exec", "--yes", "--package", CODEX_PACKAGE_SPEC, "--", "codex"]
        : ["dlx", CODEX_PACKAGE_SPEC],
    source,
  };
}

function toArray(
  value: readonly CodexLauncherInput[] | CodexLauncherInput,
): readonly CodexLauncherInput[] {
  return Array.isArray(value) ? value : [value as CodexLauncherInput];
}

function normalizeLauncher(
  value: CodexLauncherInput,
  source: CodexLauncherSource,
): CodexLauncher | undefined {
  if (typeof value === "string") {
    const command = value.trim();
    return command === "" ? undefined : { command, argsPrefix: [], source };
  }
  if (typeof value !== "object" || value === null || typeof value.command !== "string")
    return undefined;
  const command = value.command.trim();
  if (command === "" || !Array.isArray(value.argsPrefix)) return undefined;
  if (!value.argsPrefix.every((arg): arg is string => typeof arg === "string")) return undefined;
  return { command, argsPrefix: [...value.argsPrefix], source };
}

function deduplicate(candidates: readonly CodexLauncher[]): readonly CodexLauncher[] {
  const seen = new Set<string>();
  const result: CodexLauncher[] = [];
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.command, candidate.argsPrefix]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
