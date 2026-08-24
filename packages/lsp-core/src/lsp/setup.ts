// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { contextCwd } from "../request-context.ts";
import { BUILTIN_SERVERS, LSP_INSTALL_HINTS, builtinServerConfigs } from "./server-definitions.ts";
import { resolveServerExecutable } from "./server-installation.ts";
import type { ServerInstallationOptions } from "./server-installation.ts";
import {
  decodeLspSchema,
  isRecord,
  JsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "./schema.ts";
import { LspSetupError } from "./errors.ts";

export interface LspSetupInput {
  readonly serverId: string;
  readonly root?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly extensions?: readonly string[];
  readonly configPath?: string;
}
export interface LspSetupResult {
  readonly status: "configured";
  readonly serverId: string;
  readonly command: readonly string[];
  readonly configPath: string;
  readonly installHint?: string;
}
export interface LspDetectionResult {
  readonly serverId: string;
  readonly extensions: readonly string[];
  readonly executable: string;
  readonly installed: boolean;
  readonly resolvedPath: string | null;
  readonly configuredIn: readonly string[];
}
export interface LspSetupFileSystem {
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly writeText: (path: string, text: string) => void;
  readonly mkdir: (path: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly readDirectory: (path: string) => readonly string[];
  readonly isFile: (path: string) => boolean;
  readonly realpath?: (path: string) => string;
}

const defaultFileSystem: LspSetupFileSystem = {
  exists: existsSync,
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, text) => writeFileSync(path, text, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rename: renameSync,
  readDirectory: readdirSync,
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath: realpathSync,
};

function effectiveExtension(name: string): string {
  return basename(name) === "Dockerfile" || basename(name) === "Containerfile"
    ? ".dockerfile"
    : extname(name).toLowerCase();
}

function readConfiguredIds(path: string, fileSystem: LspSetupFileSystem): readonly string[] {
  if (!fileSystem.exists(path)) return [];
  try {
    const parsed: unknown = JSON.parse(fileSystem.readText(path));
    const config = decodeLspSchema(JsonObjectSchema, parsed);
    const lsp = isRecord(config) ? config["lsp"] : undefined;
    return isRecord(lsp) ? Object.keys(lsp) : [];
  } catch {
    return [];
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function ownedConfigPath(
  root: string,
  requested: string | undefined,
  fileSystem: LspSetupFileSystem,
): string {
  const workspace = resolve(root);
  const configDirectory = join(workspace, ".codex");
  if (fileSystem.exists(configDirectory) && fileSystem.realpath !== undefined) {
    try {
      if (!isInside(workspace, fileSystem.realpath(configDirectory))) {
        throw new LspSetupError(
          "setup_owned_path",
          "The HolyCodex project configuration directory resolves outside the workspace root.",
        );
      }
    } catch (error: unknown) {
      if (error instanceof LspSetupError) throw error;
      throw new LspSetupError(
        "setup_owned_path",
        `The HolyCodex project configuration directory could not be validated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const path = resolve(workspace, requested ?? join(".codex", "lsp-client.json"));
  const rel = relative(workspace, path).replaceAll("\\", "/");
  if (
    !isInside(workspace, path) ||
    (rel !== ".codex/lsp-client.json" && rel !== ".codex/lsp.json")
  ) {
    throw new LspSetupError(
      "setup_owned_path",
      "lsp_setup may write only .codex/lsp-client.json or .codex/lsp.json inside the workspace root.",
    );
  }
  return path;
}

/** Scans source files and reports existing servers without executing or installing anything. */
export function detectLsp(
  root = contextCwd(),
  fileSystem: LspSetupFileSystem = defaultFileSystem,
  installation: ServerInstallationOptions = {},
): readonly LspDetectionResult[] {
  const extensions = new Set<string>();
  const configPaths = [join(root, ".codex", "lsp-client.json"), join(root, ".codex", "lsp.json")];
  const stack = [root];
  let visited = 0;
  const skipped = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "out",
    "target",
    ".venv",
    "venv",
    "vendor",
    "coverage",
  ]);
  while (stack.length > 0 && visited < 50_000) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: readonly string[];
    try {
      entries = fileSystem.readDirectory(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= 50_000) break;
      const path = join(current, entry);
      if (!fileSystem.exists(path)) continue;
      if (fileSystem.isFile(path)) {
        visited += 1;
        const extension = effectiveExtension(entry);
        if (extension.length > 0) extensions.add(extension);
      } else if (!skipped.has(entry)) stack.push(path);
    }
  }
  return builtinServerConfigs()
    .filter((server) => server.extensions.some((extension) => extensions.has(extension)))
    .map((server) => {
      const executable = server.command[0] ?? server.id;
      const resolvedPath = resolveServerExecutable(server.command, installation);
      return {
        serverId: server.id,
        extensions: [...server.extensions],
        executable,
        installed: resolvedPath !== null,
        resolvedPath,
        configuredIn: configPaths.filter((path) =>
          readConfiguredIds(path, fileSystem).includes(server.id),
        ),
      };
    });
}

/** Validates an explicit executable and writes only the HolyCodex-owned project LSP config. */
export function setupLspServer(
  input: LspSetupInput,
  fileSystem: LspSetupFileSystem = defaultFileSystem,
  installation: ServerInstallationOptions = {},
): LspSetupResult {
  const root = resolve(input.root ?? contextCwd());
  const builtin = BUILTIN_SERVERS[input.serverId];
  const command =
    input.executable === undefined ? builtin?.command : [input.executable, ...(input.args ?? [])];
  if (
    command === undefined ||
    command.length === 0 ||
    (builtin === undefined && (input.extensions === undefined || input.extensions.length === 0))
  )
    throw new LspSetupError(
      "setup_required",
      `Unknown or incomplete LSP server '${input.serverId}'. Provide an explicit server executable and configuration.`,
    );
  const resolved = resolveServerExecutable(command, installation);
  if (resolved === null)
    throw new LspSetupError(
      "setup_required",
      `LSP server '${input.serverId}' is unavailable. Install or expose '${command[0]}' explicitly, then retry lsp_setup. Automatic network installation is disabled. Prescription: ${LSP_INSTALL_HINTS[input.serverId] ?? `install ${command[0]}`}`,
    );
  const configPath = ownedConfigPath(root, input.configPath, fileSystem);
  let current: JsonObject = {};
  if (fileSystem.exists(configPath)) {
    try {
      const parsed: unknown = JSON.parse(fileSystem.readText(configPath));
      current = decodeLspSchema(JsonObjectSchema, parsed) ?? {};
    } catch {
      throw new LspSetupError(
        "setup_required",
        `Existing HolyCodex LSP config is malformed: ${configPath}`,
      );
    }
  }
  const existingLsp = decodeLspSchema(JsonObjectSchema, current["lsp"]);
  const lsp: Record<string, JsonValue> = existingLsp === undefined ? {} : { ...existingLsp };
  lsp[input.serverId] = {
    command: [...command],
    extensions: [...(input.extensions ?? builtin?.extensions ?? [])],
  };
  const next: JsonObject = { ...current, lsp };
  fileSystem.mkdir(dirname(configPath));
  const temporary = `${configPath}.tmp-${process.pid}`;
  fileSystem.writeText(temporary, `${JSON.stringify(next, null, 2)}\n`);
  fileSystem.rename(temporary, configPath);
  return {
    status: "configured",
    serverId: input.serverId,
    command: [...command],
    configPath,
    ...(LSP_INSTALL_HINTS[input.serverId] === undefined
      ? {}
      : { installHint: LSP_INSTALL_HINTS[input.serverId] }),
  };
}
