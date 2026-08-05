import { createInterface } from "node:readline";

import type { AgentOptions, JsonValue, WorkflowInput } from "./index.js";
import { runWorkflow } from "./index.js";

type HostMessage =
  | {
      readonly type: "start";
      readonly script: string;
      readonly args?: JsonValue;
      readonly limits?: WorkflowInput["limits"];
    }
  | { readonly type: "agent-result"; readonly id: number; readonly result: JsonValue }
  | { readonly type: "agent-error"; readonly id: number; readonly error: string };

const lines = createInterface({ input: process.stdin });
const pending = new Map<
  number,
  { readonly resolve: (value: JsonValue) => void; readonly reject: (error: Error) => void }
>();
let nextId = 1;
let started = false;

lines.on("line", (line) => {
  const message = parseMessage(line);
  if (message === undefined) return;
  if (message.type === "start") {
    if (started) {
      send({ type: "error", error: "Workflow evaluator accepts one start request." });
      return;
    }
    started = true;
    void execute(message);
    return;
  }
  const request = pending.get(message.id);
  if (request === undefined) return;
  pending.delete(message.id);
  if (message.type === "agent-result") request.resolve(message.result);
  else request.reject(new Error(message.error));
});

async function execute(message: Extract<HostMessage, { readonly type: "start" }>): Promise<void> {
  try {
    const result = await runWorkflow({
      script: message.script,
      ...(message.args === undefined ? {} : { args: message.args }),
      ...(message.limits === undefined ? {} : { limits: message.limits }),
      onEvent: (event) => send({ type: "event", event }),
      executor: async (prompt, options) => await requestAgent(prompt, options),
    });
    send({ type: "result", result });
    lines.close();
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : "Workflow failed." });
    lines.close();
    process.exitCode = 1;
  }
}

async function requestAgent(prompt: string, options: AgentOptions): Promise<JsonValue> {
  const id = nextId++;
  const result = new Promise<JsonValue>((resolve, reject) => pending.set(id, { resolve, reject }));
  send({ type: "agent", id, prompt, options });
  return await result;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseMessage(line: string): HostMessage | undefined {
  try {
    const value = JSON.parse(line) as HostMessage;
    return typeof value === "object" && value !== null && "type" in value ? value : undefined;
  } catch {
    return undefined;
  }
}
