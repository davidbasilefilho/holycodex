import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  runWorkflow,
  type AgentOptions,
  type JsonValue,
  type WorkflowLimits,
  type WorkflowEvent,
  type WorkflowResult,
} from "@holycodex/workflow-runtime";

import {
  CodexAppServerClient,
  type AgentExecution,
  type AgentRoute,
  type AppServerPolicy,
} from "./app-server.js";

export type PlanLimits = WorkflowLimits & {
  readonly maxRuntimeMs?: number;
  readonly maxScriptBytes?: number;
};

export type WorkflowRunRequest = {
  readonly script: string;
  readonly args?: JsonValue;
  readonly meta?: JsonValue;
  readonly phase?: string;
  readonly projectPath?: string;
  readonly trusted?: boolean;
  readonly route?: AgentRoute;
  readonly routes?: Readonly<Record<string, AgentRoute>>;
  readonly permittedRoutes?: Readonly<Record<string, readonly AgentRoute[]>>;
  readonly policy?: AppServerPolicy;
  readonly limits?: PlanLimits;
  readonly signal?: AbortSignal;
};

export type CompletedAgent = {
  readonly replayKey: string;
  readonly result: JsonValue;
  readonly usage: AgentExecution["usage"];
  readonly agent?: string;
  readonly label?: string;
  readonly phase?: string;
};

export type WorkflowPhaseState = {
  readonly started: number;
  readonly completed: number;
  readonly errors: number;
};

export type WorkflowJournal = {
  readonly id: string;
  readonly status: "running" | "completed" | "failed" | "paused" | "cancelled";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly script: string;
  readonly args?: JsonValue;
  readonly scriptDigest: string;
  readonly meta: JsonValue | null;
  readonly phase?: string;
  readonly projectPath?: string;
  readonly trusted: boolean;
  readonly plan: string;
  readonly planLimits: PlanLimits;
  readonly route?: AgentRoute;
  readonly routes?: Readonly<Record<string, AgentRoute>>;
  readonly permittedRoutes?: Readonly<Record<string, readonly AgentRoute[]>>;
  readonly policy?: AppServerPolicy;
  readonly completed: Readonly<Record<string, CompletedAgent>>;
  readonly phases: Readonly<Record<string, WorkflowPhaseState>>;
  readonly metrics: {
    readonly calls: number;
    readonly active: number;
    readonly peakConcurrency: number;
    readonly retries: number;
  };
  readonly usage: AgentExecution["usage"];
  readonly errors: readonly string[];
  readonly cancellation: { readonly requested: boolean; readonly reason?: string };
  readonly result?: JsonValue;
};

export type WorkflowManagerOptions = {
  readonly storageDir: string;
  readonly userSavedDir?: string;
  readonly projectSavedDir?: string;
  readonly projectPath?: string;
  readonly trusted?: boolean;
  readonly plan?: string;
  readonly planLimits?: PlanLimits;
  readonly client?: CodexAppServerClient;
  readonly clientFactory?: () => CodexAppServerClient;
  readonly policy?: AppServerPolicy;
  readonly runner?: typeof runWorkflow;
};

const DEFAULT_LIMITS: PlanLimits = {
  maxCalls: 16,
  maxConcurrency: 3,
  maxRetries: 2,
  maxRuntimeMs: 120_000,
  maxScriptBytes: 50_000,
};

/** Persists workflow runs atomically and bridges workflow-runtime to Codex. */
export class WorkflowManager {
  private readonly options: WorkflowManagerOptions;
  private readonly active = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly client: CodexAppServerClient;
      readonly calls: Map<string, AbortController>;
    }
  >();
  private readonly paused = new Set<string>();

  public constructor(options: WorkflowManagerOptions) {
    this.options = options;
  }

  /** Executes a workflow and writes its journal after each public lifecycle transition. */
  public async run(request: WorkflowRunRequest): Promise<{
    readonly id: string;
    readonly result: WorkflowResult;
    readonly journal: WorkflowJournal;
  }> {
    const limits = { ...DEFAULT_LIMITS, ...this.options.planLimits, ...request.limits };
    const bytes = new TextEncoder().encode(request.script).byteLength;
    if (bytes > (limits.maxScriptBytes ?? DEFAULT_LIMITS.maxScriptBytes ?? Number.MAX_SAFE_INTEGER))
      throw new RangeError("Workflow script exceeds active plan limit.");
    const projectPath = request.projectPath ?? this.options.projectPath;
    const canonicalProject =
      projectPath === undefined ? undefined : await canonicalPath(projectPath);
    const trusted = request.trusted ?? this.options.trusted ?? false;
    if (canonicalProject !== undefined && !trusted)
      throw new Error("Project trust is required for workflow execution.");
    const id = randomUUID();
    const started = new Date().toISOString();
    const journalState: MutableJournal = {
      id,
      status: "running",
      createdAt: started,
      updatedAt: started,
      script: request.script,
      scriptDigest: digest(request.script),
      meta: sanitize(request.meta ?? null),
      ...(request.phase === undefined ? {} : { phase: request.phase }),
      ...(canonicalProject === undefined ? {} : { projectPath: canonicalProject }),
      trusted,
      plan: this.options.plan ?? "unknown",
      planLimits: limits,
      ...(request.args === undefined ? {} : { args: sanitize(request.args) }),
      ...(request.route === undefined ? {} : { route: request.route }),
      ...(request.routes === undefined ? {} : { routes: request.routes }),
      ...(request.permittedRoutes === undefined
        ? {}
        : { permittedRoutes: request.permittedRoutes }),
      ...(request.policy === undefined
        ? {}
        : { policy: sanitize(request.policy) as AppServerPolicy }),
      completed: {},
      phases: {},
      metrics: { calls: 0, active: 0, peakConcurrency: 0, retries: 0 },
      usage: {},
      errors: [],
      cancellation: { requested: false },
    };
    Object.assign(journalState.completed, await this.loadReplayCache(journalState));
    await this.writeJournal(journalState);
    const controller = new AbortController();
    if (request.signal?.aborted === true) controller.abort(request.signal.reason);
    const abortFromCaller = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const client = this.options.client ?? this.options.clientFactory?.();
    if (client === undefined)
      throw new Error("Workflow manager requires a Codex App Server client.");
    const activeState = { controller, client, calls: new Map<string, AbortController>() };
    this.active.set(id, activeState);
    const controlTimer = setInterval(() => {
      void this.readControl(id, activeState);
    }, 100);
    controlTimer.unref();
    let callIndex = 0;
    let journalWrites = Promise.resolve();
    const recordEvent = (event: WorkflowEvent): void => {
      updateOperationalState(journalState, event);
      journalState.updatedAt = new Date().toISOString();
      journalWrites = journalWrites.then(async () => await this.writeJournal(journalState));
    };
    try {
      const workflow = await (this.options.runner ?? runWorkflow)({
        script: request.script,
        ...(request.args === undefined ? {} : { args: request.args }),
        signal: controller.signal,
        limits,
        onEvent: recordEvent,
        executor: async (prompt, agentOptions) => {
          const callId = String(++callIndex);
          const agentName =
            typeof (agentOptions as AgentOptions & { readonly agent?: unknown }).agent === "string"
              ? (agentOptions as AgentOptions & { readonly agent: string }).agent
              : undefined;
          const route = resolveRoute(request, agentName, agentOptions.stage);
          const replayKey = computeReplayKey(
            request.script,
            prompt,
            agentOptions,
            canonicalProject,
            trusted,
            route,
            limits,
            this.options.plan ?? "unknown",
          );
          const cached = journalState.completed[replayKey];
          if (cached !== undefined) return cached.result;
          if (controller.signal.aborted) throw new Error("Workflow cancelled.");
          const callController = new AbortController();
          const abortCall = (): void => callController.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", abortCall, { once: true });
          activeState.calls.set(callId, callController);
          let execution: AgentExecution;
          try {
            execution = await client.execute(prompt, {
              ...request.policy,
              ...agentOptions,
              route,
              signal: callController.signal,
              ...(canonicalProject === undefined && request.policy?.cwd === undefined
                ? {}
                : { cwd: canonicalProject ?? request.policy?.cwd }),
            });
          } finally {
            controller.signal.removeEventListener("abort", abortCall);
            activeState.calls.delete(callId);
          }
          journalState.completed[replayKey] = {
            replayKey,
            result: sanitize(execution.result),
            usage: execution.usage,
            ...(agentOptions.agent === undefined ? {} : { agent: agentOptions.agent }),
            ...(agentOptions.label === undefined ? {} : { label: agentOptions.label }),
            ...(agentOptions.phase === undefined ? {} : { phase: agentOptions.phase }),
          };
          journalState.usage = addUsage(journalState.usage, execution.usage);
          journalState.updatedAt = new Date().toISOString();
          journalWrites = journalWrites.then(async () => await this.writeJournal(journalState));
          await journalWrites;
          void callId;
          return execution.result;
        },
      });
      journalState.result = sanitize(workflow.result);
      await journalWrites;
      journalState.errors = workflow.errors.map((error) => sanitizeError(error));
      journalState.status = this.paused.has(id)
        ? "paused"
        : controller.signal.aborted
          ? "cancelled"
          : workflow.errors.length > 0
            ? "failed"
            : "completed";
      journalState.cancellation = {
        requested: controller.signal.aborted,
        ...(controller.signal.aborted
          ? { reason: String(controller.signal.reason ?? "cancelled") }
          : {}),
      };
      journalState.updatedAt = new Date().toISOString();
      await this.writeJournal(journalState);
      return { id, result: workflow, journal: freezeJournal(journalState) };
    } catch (error) {
      await journalWrites;
      journalState.status = this.paused.has(id)
        ? "paused"
        : controller.signal.aborted
          ? "cancelled"
          : "failed";
      journalState.errors = [...journalState.errors, sanitizeError(error)];
      journalState.cancellation = {
        requested: controller.signal.aborted,
        ...(controller.signal.aborted
          ? { reason: String(controller.signal.reason ?? "cancelled") }
          : {}),
      };
      journalState.updatedAt = new Date().toISOString();
      await this.writeJournal(journalState);
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", abortFromCaller);
      this.active.delete(id);
      this.paused.delete(id);
      clearInterval(controlTimer);
      if (this.options.client === undefined) await client.close();
    }
  }

  /** Reads one persisted run journal. */
  public async show(id: string): Promise<WorkflowJournal> {
    return await this.readJournal(id);
  }
  /** Lists persisted run journals in creation order. */
  public async list(): Promise<readonly WorkflowJournal[]> {
    await mkdir(this.options.storageDir, { recursive: true });
    const names = (await readdir(this.options.storageDir))
      .filter((name) => name.startsWith("run-") && name.endsWith(".json"))
      .sort();
    const result: WorkflowJournal[] = [];
    for (const name of names) {
      try {
        result.push(await this.readJournal(name.slice(4, -5)));
      } catch {
        /* ignore incomplete atomic writes */
      }
    }
    return result;
  }
  /** Marks a run paused. A running QuickJS invocation is cancelled at its next boundary. */
  public async pause(id: string): Promise<WorkflowJournal> {
    this.paused.add(id);
    this.active.get(id)?.controller.abort("paused");
    await this.writeControl(id, { action: "pause" });
    return await this.setStatus(id, "paused");
  }
  /** Resumes a paused run by replaying its non-completed calls. */
  public async resume(id: string): Promise<WorkflowJournal> {
    const journal = await this.readJournal(id);
    if (journal.status !== "paused") return journal;
    return (await this.runFromJournal(journal)).journal;
  }
  /** Cancels one active agent/run and terminates its process tree. */
  public async stopAgent(id: string, callId?: string | number): Promise<WorkflowJournal> {
    const active = this.active.get(id);
    if (active !== undefined && callId !== undefined) {
      const normalizedCallId = String(callId);
      active.calls.get(normalizedCallId)?.abort("agent stopped");
      await this.writeControl(id, { action: "stop-call", callId: normalizedCallId });
      return await this.readJournal(id);
    }
    if (active !== undefined) active.controller.abort("agent stopped");
    await this.writeControl(id, { action: "stop-run", reason: "agent stopped" });
    return await this.setStatus(id, "cancelled", "agent stopped");
  }
  /** Cancels all active calls in a run. */
  public async stopRun(id: string): Promise<WorkflowJournal> {
    const active = this.active.get(id);
    if (active !== undefined) active.controller.abort("run stopped");
    await this.writeControl(id, { action: "stop-run", reason: "run stopped" });
    return await this.setStatus(id, "cancelled", "run stopped");
  }
  /** Restarts a failed run using its persisted script identity. */
  public async restartFailed(id: string): Promise<WorkflowJournal> {
    const journal = await this.readJournal(id);
    if (journal.status !== "failed" && journal.status !== "cancelled")
      throw new Error("Only failed or cancelled runs can be restarted.");
    return (await this.runFromJournal(journal)).journal;
  }
  /** Reopens a run from disk without executing it. */
  public async reopen(id: string): Promise<WorkflowJournal> {
    return await this.readJournal(id);
  }

  /** Saves a workflow under the user or trusted project scope. */
  public async save(
    name: string,
    script: string,
    scope: "user" | "project" = "user",
  ): Promise<string> {
    const directory = await this.savedDirectory(scope);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Saved workflow name is invalid.");
    await mkdir(directory, { recursive: true });
    const target = await safeChildPath(directory, `${name}.js`);
    await writeFile(target, script, { encoding: "utf8", mode: 0o600 });
    return target;
  }
  /** Invokes a saved workflow after scope and trust checks. */
  public async invokeSaved(
    name: string,
    args?: JsonValue,
    scope: "user" | "project" = "user",
    execution: Pick<
      WorkflowRunRequest,
      "route" | "routes" | "permittedRoutes" | "policy" | "limits"
    > = {},
  ): Promise<{
    readonly id: string;
    readonly result: WorkflowResult;
    readonly journal: WorkflowJournal;
  }> {
    const directory = await this.savedDirectory(scope);
    const target = await safeChildPath(directory, `${name}.js`);
    const script = await readFile(target, "utf8");
    return await this.run({
      script,
      ...(args === undefined ? {} : { args }),
      ...(scope === "project" && this.options.projectPath !== undefined
        ? { projectPath: this.options.projectPath }
        : {}),
      trusted: scope === "project" ? (this.options.trusted ?? false) : true,
      ...execution,
    });
  }

  private async savedDirectory(scope: "user" | "project"): Promise<string> {
    if (scope === "project") {
      if (this.options.trusted !== true || this.options.projectPath === undefined)
        throw new Error("Trusted project scope is required.");
      return await canonicalPath(
        this.options.projectSavedDir ?? join(this.options.projectPath, ".holycodex", "workflows"),
      );
    }
    return await canonicalPath(this.options.userSavedDir ?? join(this.options.storageDir, "saved"));
  }
  private async runFromJournal(journal: WorkflowJournal): Promise<{
    readonly id: string;
    readonly result: WorkflowResult;
    readonly journal: WorkflowJournal;
  }> {
    return await this.run({
      script: journal.script,
      ...(journal.args === undefined ? {} : { args: journal.args }),
      ...(journal.projectPath === undefined ? {} : { projectPath: journal.projectPath }),
      trusted: journal.trusted,
      limits: journal.planLimits,
      ...(journal.route === undefined ? {} : { route: journal.route }),
      ...(journal.routes === undefined ? {} : { routes: journal.routes }),
      ...(journal.permittedRoutes === undefined
        ? {}
        : { permittedRoutes: journal.permittedRoutes }),
      ...(journal.policy === undefined ? {} : { policy: journal.policy }),
    });
  }
  private async setStatus(
    id: string,
    status: WorkflowJournal["status"],
    reason?: string,
  ): Promise<WorkflowJournal> {
    const journal = (await this.readJournal(id)) as MutableJournal;
    journal.status = status;
    journal.updatedAt = new Date().toISOString();
    if (status === "cancelled")
      journal.cancellation = { requested: true, ...(reason === undefined ? {} : { reason }) };
    await this.writeJournal(journal);
    return freezeJournal(journal);
  }
  private async readControl(
    id: string,
    active: { readonly controller: AbortController; readonly calls: Map<string, AbortController> },
  ): Promise<void> {
    try {
      const control = JSON.parse(await readFile(await this.controlPath(id), "utf8")) as {
        readonly action?: string;
        readonly callId?: string;
        readonly reason?: string;
      };
      if (control.action === "pause") {
        this.paused.add(id);
        active.controller.abort("paused");
      } else if (control.action === "stop-run")
        active.controller.abort(control.reason ?? "run stopped");
      else if (control.action === "stop-call" && control.callId !== undefined)
        active.calls.get(control.callId)?.abort(control.reason ?? "agent stopped");
    } catch {
      // No control file is the normal running state.
    }
  }
  private async writeControl(
    id: string,
    value: { readonly action: string; readonly callId?: string; readonly reason?: string },
  ): Promise<void> {
    await mkdir(this.options.storageDir, { recursive: true });
    const target = await this.controlPath(id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
  private async controlPath(id: string): Promise<string> {
    return await safeChildPath(this.options.storageDir, `run-${id}.control.json`);
  }
  private async journalPath(id: string): Promise<string> {
    return await safeChildPath(this.options.storageDir, `run-${id}.json`);
  }
  private async writeJournal(journal: MutableJournal): Promise<void> {
    await mkdir(this.options.storageDir, { recursive: true });
    const target = await this.journalPath(journal.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
  private async loadReplayCache(current: MutableJournal): Promise<Record<string, CompletedAgent>> {
    try {
      const names = (await readdir(this.options.storageDir)).filter(
        (name) => name.startsWith("run-") && name.endsWith(".json"),
      );
      const cache: Record<string, CompletedAgent> = {};
      for (const name of names) {
        try {
          const previous = JSON.parse(
            await readFile(join(this.options.storageDir, name), "utf8"),
          ) as WorkflowJournal;
          if (
            previous.scriptDigest !== current.scriptDigest ||
            previous.projectPath !== current.projectPath ||
            previous.trusted !== current.trusted ||
            stableStringify(previous.planLimits) !== stableStringify(current.planLimits)
          )
            continue;
          Object.assign(cache, previous.completed);
        } catch {
          /* ignore malformed or concurrently replaced journals */
        }
      }
      return cache;
    } catch {
      return {};
    }
  }
  private async readJournal(id: string): Promise<WorkflowJournal> {
    return JSON.parse(await readFile(await this.journalPath(id), "utf8")) as WorkflowJournal;
  }
}

/** Canonicalizes a path and rejects symlink escapes from its existing parent. */
export async function canonicalPath(path: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(path);
  let cursor = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      const real = await realpath(cursor);
      return suffix.reverse().reduce((value, part) => join(value, part), real);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`Path does not have a resolvable parent: ${path}`);
      suffix.push(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Ensures a filename remains below a canonical directory, including symlink checks. */
export async function safeChildPath(directory: string, child: string): Promise<string> {
  const root = await canonicalPath(directory);
  const target = resolve(root, child);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Path escapes workflow scope.");
  try {
    const existing = await canonicalPath(target);
    const existingRel = relative(root, existing);
    if (existingRel.startsWith(`..${sep}`) || isAbsolute(existingRel))
      throw new Error("Symlink escapes workflow scope.");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Path does not")) throw error;
  }
  return target;
}

export function computeReplayKey(
  script: string,
  prompt: string,
  options: AgentOptions,
  projectPath: string | undefined,
  trusted: boolean,
  route: AgentRoute | undefined,
  limits: PlanLimits,
  plan: string,
): string {
  return digest(
    stableStringify({
      script: digest(script),
      prompt: digest(prompt),
      options,
      projectPath,
      trusted,
      route,
      limits,
      plan,
    }),
  );
}

function resolveRoute(
  request: WorkflowRunRequest,
  agentName: string | undefined,
  stage: string | undefined,
): AgentRoute | undefined {
  if (agentName !== undefined && request.routes !== undefined) {
    const route =
      request.routes[stage === undefined ? agentName : `${agentName}:${stage}`] ??
      request.routes[agentName];
    if (route === undefined) throw new Error(`No route configured for agent: ${agentName}`);
    const permitted = request.permittedRoutes?.[agentName];
    if (permitted !== undefined && !permitted.some((candidate) => routeMatches(candidate, route)))
      throw new Error(`Route is not permitted for agent: ${agentName}`);
    return route;
  }
  if (agentName !== undefined && request.route === undefined)
    throw new Error(`No route configured for agent: ${agentName}`);
  if (request.route !== undefined && agentName !== undefined) {
    const selectedRoute = request.route;
    const permitted = request.permittedRoutes?.[agentName];
    if (
      permitted !== undefined &&
      !permitted.some((candidate) => routeMatches(candidate, selectedRoute))
    )
      throw new Error(`Route is not permitted for agent: ${agentName}`);
  }
  return request.route;
}

function routeMatches(permitted: AgentRoute, selected: AgentRoute): boolean {
  return (
    permitted.model === selected.model &&
    permitted.reasoningEffort === selected.reasoningEffort &&
    (permitted.agent === undefined || permitted.agent === selected.agent)
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
function sanitize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object" && value !== null) {
    const blocked = /prompt|system|reasoning|credential|password|secret|token|transcript/i;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !blocked.test(key))
        .map(([key, child]) => [key, sanitize(child)]),
    );
  }
  return null;
}
function sanitizeError(error: unknown): string {
  if (error instanceof Error && /cancel|timeout|quota|trust|plan|script/i.test(error.message))
    return error.message.slice(0, 200);
  return "Workflow failed.";
}
function addUsage(a: AgentExecution["usage"], b: AgentExecution["usage"]): AgentExecution["usage"] {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  };
}
type MutableJournal = { -readonly [K in keyof WorkflowJournal]: WorkflowJournal[K] } & {
  completed: Record<string, CompletedAgent>;
  errors: string[];
  usage: AgentExecution["usage"];
  cancellation: { requested: boolean; reason?: string };
  status: WorkflowJournal["status"];
  updatedAt: string;
  result?: JsonValue;
  phases: Record<string, WorkflowPhaseState>;
  metrics: { calls: number; active: number; peakConcurrency: number; retries: number };
};
function freezeJournal(journal: MutableJournal): WorkflowJournal {
  return JSON.parse(JSON.stringify(journal)) as WorkflowJournal;
}

function updateOperationalState(journal: MutableJournal, event: WorkflowEvent): void {
  if (event.type === "call-start") {
    journal.metrics.calls += 1;
    journal.metrics.active += 1;
    journal.metrics.peakConcurrency = Math.max(
      journal.metrics.peakConcurrency,
      journal.metrics.active,
    );
  } else if (event.type === "call-complete") {
    journal.metrics.active = Math.max(0, journal.metrics.active - 1);
    journal.metrics.retries += Math.max(0, event.attempt - 1);
  } else if (event.type === "call-failed") {
    journal.metrics.active = Math.max(0, journal.metrics.active - 1);
  } else if (event.type === "call-error" && event.attempt > 1) {
    journal.metrics.retries += 1;
  }
  if (!("phase" in event) || event.phase === undefined) return;
  const phase = journal.phases[event.phase] ?? { started: 0, completed: 0, errors: 0 };
  journal.phases[event.phase] = {
    started: phase.started + (event.type === "call-start" ? 1 : 0),
    completed: phase.completed + (event.type === "call-complete" ? 1 : 0),
    errors: phase.errors + (event.type === "call-failed" ? 1 : 0),
  };
}
