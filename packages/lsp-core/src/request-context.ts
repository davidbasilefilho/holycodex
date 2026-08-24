// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs a request with its explicit workspace and environment context. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Returns the request workspace or the process workspace. */
export function contextCwd(): string {
  return storage.getStore()?.cwd ?? process.cwd();
}

/** Returns a request environment value, falling back to the process environment. */
export function contextEnv(key: string): string | undefined {
  const context = storage.getStore();
  return context?.env?.[key] ?? process.env[key];
}

/** Returns a complete request environment for a child process. */
export function contextEnvironment(): Readonly<Record<string, string | undefined>> {
  const base: Record<string, string | undefined> = { ...process.env };
  const scoped = storage.getStore()?.env;
  if (scoped !== undefined) {
    for (const [key, value] of Object.entries(scoped)) base[key] = value;
  }
  return base;
}
