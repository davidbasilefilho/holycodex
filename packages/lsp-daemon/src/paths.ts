// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { decodeLspSchema } from "@holycodex/lsp-core";

const requireFromHere = createRequire(import.meta.url);
const VersionSchema = Schema.Struct({ version: Schema.String.pipe(Schema.minLength(1)) });
const VERSION_ENV = "CODEX_LSP_DAEMON_VERSION";
const MAX_SOCKET_PATH_LENGTH = 100;

export interface DaemonPaths {
  readonly version: string;
  readonly dir: string;
  readonly socket: string;
  readonly lock: string;
  readonly pid: string;
  readonly log: string;
}

function safeVersion(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(trimmed) ? trimmed : null;
}

/** Resolves the daemon package version without trusting arbitrary manifest shape. */
export function resolveDaemonVersion(requireFn: (id: string) => unknown = requireFromHere): string {
  for (const candidate of ["./package.json", "../package.json"]) {
    try {
      const parsed = decodeLspSchema(VersionSchema, requireFn(candidate));
      if (parsed !== undefined) return safeVersion(parsed.version) ?? "0";
    } catch {
      /* try the next manifest */
    }
  }
  return "0";
}

/** Applies the documented daemon directory precedence. */
export function daemonBaseDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env["CODEX_LSP_DAEMON_DIR"]?.trim();
  if (explicit) return explicit;
  const pluginData = env["PLUGIN_DATA"]?.trim();
  if (pluginData) return join(pluginData, "daemon");
  const codexHome = env["CODEX_HOME"]?.trim();
  return join(
    codexHome && codexHome.length > 0 ? codexHome : join(homedir(), ".codex"),
    "codex-lsp",
    "daemon",
  );
}

/** Returns version-scoped daemon state and the platform-safe endpoint. */
export function daemonPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
  version = resolveDaemonVersionFromEnv(env) ?? resolveDaemonVersion(),
): DaemonPaths {
  const validVersion = safeVersion(version) ?? "0";
  const base = resolve(daemonBaseDir(env));
  const dir = join(base, `v${validVersion}`);
  const digest = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\holycodex-lsp-${validVersion}-${digest}`
      : join(dir, "daemon.sock").length < MAX_SOCKET_PATH_LENGTH
        ? join(dir, "daemon.sock")
        : join(tmpdir(), `holycodex-lsp-${validVersion}-${digest}.sock`);
  return {
    version: validVersion,
    dir,
    socket,
    lock: join(dir, "daemon.lock"),
    pid: join(dir, "daemon.pid"),
    log: join(dir, "daemon.log"),
  };
}

/** Reads a safe version override, returning null for blank or traversal-shaped values. */
export function resolveDaemonVersionFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const value = env[VERSION_ENV];
  return value === undefined ? null : safeVersion(value);
}

/** Returns the nonce state file associated with one versioned daemon directory. */
export function daemonNoncePath(paths: DaemonPaths): string {
  return join(paths.dir, "daemon.nonce");
}
