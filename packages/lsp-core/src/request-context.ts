import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  cwd?: string;
  env?: Record<string, string>;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs with request context. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Provides context working directory. */
export function contextCwd(): string {
  return storage.getStore()?.cwd ?? process.cwd();
}

/** Provides context env. */
export function contextEnv(key: string): string | undefined {
  const store = storage.getStore();
  if (store?.env) return store.env[key];
  return process.env[key];
}
