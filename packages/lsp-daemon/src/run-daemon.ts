// SPDX-License-Identifier: Apache-2.0

import { startDaemonServer } from "./daemon-server.ts";
import { daemonPaths } from "./paths.ts";
/** Runs the long-lived daemon entry point and logs non-fatal process errors. */
export async function runDaemon(): Promise<void> {
  process.on("uncaughtException", (error: unknown) =>
    process.stderr.write(
      `[lsp-daemon] uncaughtException: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    ),
  );
  process.on("unhandledRejection", (reason: unknown) =>
    process.stderr.write(
      `[lsp-daemon] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    ),
  );
  await startDaemonServer(daemonPaths());
}
