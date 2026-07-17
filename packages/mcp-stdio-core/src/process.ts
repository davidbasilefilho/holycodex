import { type ChildProcess, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";

const TRUNCATED_MARKER = "\n... diagnostic output truncated ...\n";

export type ManagedProcessInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly matchOutput?: (output: string) => boolean;
};

export type ManagedProcessRuntime = {
  readonly terminationGraceMs: number;
  readonly kill: (child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals) => void;
};

export type ManagedProcessResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly matched: boolean;
  readonly outputTruncated: boolean;
  readonly error?: string;
};

type OutputState = { head: string; tail: string; truncated: boolean };

const defaultManagedProcessRuntime: ManagedProcessRuntime = {
  terminationGraceMs: 2_000,
  kill: killProcessTree,
};

export async function runManagedProcess(
  input: ManagedProcessInput,
  runtime: ManagedProcessRuntime = defaultManagedProcessRuntime,
): Promise<ManagedProcessResult> {
  return await new Promise<ManagedProcessResult>((resolve) => {
    const child = spawn(input.command, [...input.args], {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: input.env }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: input.platform !== "win32",
    });
    let stdout: OutputState = { head: "", tail: "", truncated: false };
    let stderr: OutputState = { head: "", tail: "", truncated: false };
    let timedOut = false;
    let matched = false;
    let settled = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
      const stdoutText = outputText(stdout);
      const stderrText = outputText(stderr);
      resolve({
        exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut,
        matched,
        outputTruncated: stdout.truncated || stderr.truncated,
        ...(error === undefined ? {} : { error }),
      });
    };

    const terminate = (): void => {
      if (forceKillTimeout !== undefined) return;
      runtime.kill(child, input.platform, "SIGTERM");
      forceKillTimeout = setTimeout(() => {
        runtime.kill(child, input.platform, "SIGKILL");
      }, runtime.terminationGraceMs);
      forceKillTimeout.unref();
    };

    const inspectMatch = (): void => {
      if (matched || input.matchOutput === undefined) return;
      if (input.matchOutput(`${outputText(stdout)}\n${outputText(stderr)}`)) {
        matched = true;
        terminate();
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk.toString(), input.maxOutputChars);
      inspectMatch();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk.toString(), input.maxOutputChars);
      inspectMatch();
    });
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code));

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    timeout.unref();

    if (input.stdin === undefined) child.stdin.end();
    else child.stdin.end(input.stdin);
  });
}

export function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals = "SIGTERM",
  runTaskkill: (command: string, args: readonly string[]) => SpawnSyncReturns<Buffer> = (
    command,
    args,
  ) => spawnSync(command, [...args], { stdio: "ignore", windowsHide: true }),
): void {
  if (platform === "win32" && child.pid !== undefined) {
    const result = runTaskkill("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
    if (result.error === undefined && result.status === 0) return;
  }
  if (platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child termination when process-group termination is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited; cleanup remains settled and idempotent.
  }
}

function appendOutput(state: OutputState, chunk: string, limit: number): OutputState {
  const safeLimit = Math.max(1, limit);
  const headLimit = Math.ceil(safeLimit / 2);
  const tailLimit = Math.floor(safeLimit / 2);
  if (!state.truncated && state.head.length + chunk.length <= safeLimit)
    return { ...state, head: state.head + chunk };
  const combined = state.truncated ? chunk : state.head + chunk;
  return {
    head: state.truncated ? state.head : combined.slice(0, headLimit),
    tail: `${state.tail}${combined.slice(state.truncated ? 0 : headLimit)}`.slice(-tailLimit),
    truncated: true,
  };
}

function outputText(state: OutputState): string {
  return state.truncated ? `${state.head}${TRUNCATED_MARKER}${state.tail}` : state.head;
}
