import { runManagedProcess } from "@holycodex/mcp-stdio-core/process";

export interface GitBashRunInput {
  readonly bashPath: string;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface GitBashRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type RunGitBashCommand = (input: GitBashRunInput) => Promise<GitBashRunResult>;

/** Runs git bash command. */
export async function runGitBashCommand(input: GitBashRunInput): Promise<GitBashRunResult> {
  const env =
    input.env === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input.env).filter(([key]) => key.toLowerCase() !== "original_path"),
        );
  const result = await runManagedProcess({
    command: input.bashPath,
    args: ["-lc", input.command],
    platform: "win32",
    timeoutMs: input.timeoutMs,
    maxOutputChars: 256 * 1024,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(env === undefined ? {} : { env }),
  });
  if (result.error !== undefined) throw new Error(result.error);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}
