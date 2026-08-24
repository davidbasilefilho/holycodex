// SPDX-License-Identifier: Apache-2.0

import { IDLE_TIMEOUT_MS, INIT_TIMEOUT_MS, REAPER_INTERVAL_MS } from "./constants.ts";
import { LspClient } from "./client.ts";
import type { LspClientTransportOptions } from "./transport.ts";
import type { ResolvedServer } from "./types.ts";

interface ManagedClient {
  readonly client: LspClient;
  refCount: number;
  pendingWaiters: number;
  lastUsedAt: number;
  initPromise: Promise<void> | null;
  isInitializing: boolean;
  initializingSince: number | null;
}

export interface ClientSnapshot {
  readonly root: string;
  readonly serverId: string;
  readonly refCount: number;
  readonly pendingWaiters: number;
  readonly lastUsedAt: number;
  readonly isInitializing: boolean;
  readonly alive: boolean;
  readonly command: readonly string[];
}

export interface LspManagerOptions {
  readonly idleTimeoutMs?: number;
  readonly initTimeoutMs?: number;
  readonly reaperIntervalMs?: number;
  readonly clientFactory?: (root: string, server: ResolvedServer) => LspClient;
  readonly now?: () => number;
  readonly clientOptions?: LspClientTransportOptions;
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        reject(new DOMException("The operation was aborted", "AbortError"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      },
    );
  });
}

async function stopQuietly(client: LspClient): Promise<void> {
  try {
    await client.stop();
  } catch {
    /* cleanup must not mask the original result */
  }
}

/** Pools one initialized client per workspace/server with concurrent ensure and idle reaping. */
export class LspManager {
  private readonly clients = new Map<string, ManagedClient>();
  private readonly idleTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly clientFactory: (root: string, server: ResolvedServer) => LspClient;
  private readonly now: () => number;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: LspManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.clientFactory =
      options.clientFactory ??
      ((root, server) => new LspClient(root, server, options.clientOptions));
    this.reaper = setInterval(() => this.reap(), options.reaperIntervalMs ?? REAPER_INTERVAL_MS);
    this.reaper.unref?.();
  }

  /** Gets or initializes a pooled client; concurrent callers share one handshake. */
  async getClient(root: string, server: ResolvedServer, signal?: AbortSignal): Promise<LspClient> {
    if (this.disposed) throw new Error("LspManager has been disposed");
    const key = `${root}::${server.id}`;
    let managed = this.clients.get(key);
    if (
      managed !== undefined &&
      managed.isInitializing &&
      managed.initializingSince !== null &&
      this.now() - managed.initializingSince > this.initTimeoutMs
    ) {
      this.clients.delete(key);
      await stopQuietly(managed.client);
      managed = undefined;
    }
    if (managed === undefined) {
      const client = this.clientFactory(root, server);
      const started = this.now();
      const initPromise = (async () => {
        await client.start();
        await client.initialize();
      })();
      managed = {
        client,
        refCount: 0,
        pendingWaiters: 1,
        lastUsedAt: started,
        initPromise,
        isInitializing: true,
        initializingSince: started,
      };
      this.clients.set(key, managed);
      void initPromise.catch(async () => {
        if (this.clients.get(key)?.client !== client) return;
        this.clients.delete(key);
        await stopQuietly(client);
      });
      try {
        await waitWithSignal(initPromise, signal);
      } catch (error: unknown) {
        managed.pendingWaiters -= 1;
        if (managed.pendingWaiters === 0) {
          this.clients.delete(key);
          await stopQuietly(client);
        }
        throw error;
      }
      managed.pendingWaiters -= 1;
      managed.isInitializing = false;
      managed.initializingSince = null;
      managed.initPromise = null;
    } else if (managed.initPromise !== null) {
      managed.pendingWaiters += 1;
      try {
        await waitWithSignal(managed.initPromise, signal);
      } finally {
        managed.pendingWaiters -= 1;
      }
    }
    if (!managed.client.isAlive()) {
      this.clients.delete(key);
      await stopQuietly(managed.client);
      return this.getClient(root, server, signal);
    }
    managed.refCount += 1;
    managed.lastUsedAt = this.now();
    return managed.client;
  }

  releaseClient(root: string, serverId: string): void {
    const managed = this.clients.get(`${root}::${serverId}`);
    if (managed !== undefined && managed.refCount > 0) {
      managed.refCount -= 1;
      managed.lastUsedAt = this.now();
    }
  }

  /** Invalidates one pooled client after a dead-connection failure. */
  invalidateClient(root: string, serverId: string, client?: LspClient): void {
    const key = `${root}::${serverId}`;
    const managed = this.clients.get(key);
    if (managed === undefined || (client !== undefined && managed.client !== client)) return;
    this.clients.delete(key);
    void stopQuietly(managed.client);
  }

  warmupClient(root: string, server: ResolvedServer): void {
    if (this.disposed || this.clients.has(`${root}::${server.id}`)) return;
    void this.getClient(root, server).then(
      () => this.releaseClient(root, server.id),
      () => undefined,
    );
  }

  isServerInitializing(root: string, serverId: string): boolean {
    return this.clients.get(`${root}::${serverId}`)?.isInitializing ?? false;
  }
  hasClient(root: string, serverId: string): boolean {
    return this.clients.has(`${root}::${serverId}`);
  }
  clientCount(): number {
    return this.clients.size;
  }

  getSnapshot(): ClientSnapshot[] {
    return [...this.clients.entries()].map(([key, managed]) => {
      const separator = key.lastIndexOf("::");
      return {
        root: key.slice(0, separator),
        serverId: key.slice(separator + 2),
        refCount: managed.refCount,
        pendingWaiters: managed.pendingWaiters,
        lastUsedAt: managed.lastUsedAt,
        isInitializing: managed.isInitializing,
        alive: managed.client.isAlive(),
        command: managed.client.command(),
      };
    });
  }

  /** Stops all pooled clients and the reaper. */
  async stopAll(): Promise<void> {
    this.disposed = true;
    if (this.reaper !== null) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const clients = [...this.clients.values()].map((managed) => managed.client);
    this.clients.clear();
    await Promise.all(clients.map(stopQuietly));
  }

  private reap(): void {
    const now = this.now();
    for (const [key, managed] of this.clients) {
      if (
        managed.isInitializing &&
        managed.initializingSince !== null &&
        now - managed.initializingSince > this.initTimeoutMs
      ) {
        this.clients.delete(key);
        void stopQuietly(managed.client);
        continue;
      }
      if (
        !managed.isInitializing &&
        managed.refCount === 0 &&
        managed.pendingWaiters === 0 &&
        now - managed.lastUsedAt > this.idleTimeoutMs
      ) {
        this.clients.delete(key);
        void stopQuietly(managed.client);
      }
    }
  }
}

let defaultManager: LspManager | null = null;
/** Returns the process default LSP manager. */
export function getLspManager(): LspManager {
  return defaultManager ?? (defaultManager = new LspManager());
}
/** Disposes the process default LSP manager. */
export async function disposeDefaultLspManager(): Promise<void> {
  const manager = defaultManager;
  defaultManager = null;
  if (manager !== null) await manager.stopAll();
}
