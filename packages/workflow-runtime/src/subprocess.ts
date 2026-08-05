import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { killProcessTree } from "@holycodex/runtime-core";

import type { AgentOptions, WorkflowEvent, WorkflowInput, WorkflowResult } from "./index.js";

export type IsolatedWorkflowOptions = {
  readonly executable: string;
  readonly workerPath: string;
  readonly platform?: NodeJS.Platform;
  readonly spawnChild?: typeof spawn;
};

type WorkerMessage =
  | {
      readonly type: "agent";
      readonly id: number;
      readonly prompt: string;
      readonly options: AgentOptions;
    }
  | { readonly type: "event"; readonly event: WorkflowEvent }
  | { readonly type: "result"; readonly result: WorkflowResult }
  | { readonly type: "error"; readonly error: string };

/** Executes a workflow in a separate capability-denied evaluator process. */
export async function runWorkflowInSubprocess(
  input: WorkflowInput,
  options: IsolatedWorkflowOptions,
): Promise<WorkflowResult> {
  return await new Promise<WorkflowResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (options.spawnChild ?? spawn)(options.executable, [options.workerPath], {
        stdio: "pipe",
        windowsHide: true,
        detached: (options.platform ?? process.platform) !== "win32",
        env: minimalEnvironment(process.env, options.platform ?? process.platform),
      });
    } catch (error) {
      reject(error);
      return;
    }
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (result: WorkflowResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const terminate = (): void =>
      killProcessTree(child, options.platform ?? process.platform, "SIGTERM");
    const abort = (): void => {
      terminate();
      fail(new Error("Workflow cancelled."));
    };
    const cleanup = (): void => {
      lines.close();
      input.signal?.removeEventListener("abort", abort);
      if (!child.killed) terminate();
    };
    lines.on("line", (line) => {
      const message = parseMessage(line);
      if (message === undefined) return;
      if (message.type === "event") {
        input.onEvent?.(message.event);
        return;
      }
      if (message.type === "agent") {
        void Promise.resolve(input.executor(message.prompt, message.options)).then(
          (result) => send(child, { type: "agent-result", id: message.id, result }),
          (error: unknown) =>
            send(child, {
              type: "agent-error",
              id: message.id,
              error: error instanceof Error ? error.message : "Agent execution failed.",
            }),
        );
        return;
      }
      if (message.type === "result") finish(message.result);
      else fail(new Error(message.error));
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (!settled) fail(new Error(`Workflow evaluator exited with code ${code ?? "unknown"}.`));
    });
    input.signal?.addEventListener("abort", abort, { once: true });
    send(child, {
      type: "start",
      script: input.script,
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    });
  });
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function parseMessage(line: string): WorkerMessage | undefined {
  try {
    const value = JSON.parse(line) as WorkerMessage;
    return typeof value === "object" && value !== null && "type" in value ? value : undefined;
  } catch {
    return undefined;
  }
}

function minimalEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return {};
  return {
    ...(environment.SystemRoot === undefined ? {} : { SystemRoot: environment.SystemRoot }),
    ...(environment.WINDIR === undefined ? {} : { WINDIR: environment.WINDIR }),
  };
}
