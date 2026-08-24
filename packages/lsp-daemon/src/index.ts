// SPDX-License-Identifier: Apache-2.0

export { disposeDefaultLspManager } from "@holycodex/lsp-core";
export {
  callDiagnosticsViaDaemon,
  callToolViaDaemon,
  currentRequestContext,
  DaemonRequestError,
  type CallToolOptions,
  type DaemonToolContext,
} from "./daemon-client.ts";
export { type DaemonServerHandle, startDaemonServer } from "./daemon-server.ts";
export {
  ensureDaemonRunning,
  type EnsureDaemonDeps,
  type EnsureDaemonOptions,
  DaemonUnreachableError,
  defaultEnsureDaemonDeps,
  probeSocket,
  resolveDaemonCliPath,
  spawnDaemonProcess,
} from "./ensure-daemon.ts";
export {
  type LockHandle,
  type LockOptions,
  isProcessAlive,
  readLockPid,
  tryAcquireLock,
  unlinkQuietly,
} from "./lock.ts";
export {
  daemonBaseDir,
  daemonNoncePath,
  daemonPaths,
  resolveDaemonVersion,
  resolveDaemonVersionFromEnv,
  type DaemonPaths,
} from "./paths.ts";
export {
  type DaemonResponse,
  extractRequestContext,
  handleDaemonMessage,
  type RequestRoutingOptions,
  type RoutedRequest,
  CONTEXT_KEY,
} from "./request-routing.ts";
export { createLineDecoder, encodeJsonLine, type LineDecoder } from "./socket-json.ts";
export { runDaemon } from "./run-daemon.ts";
