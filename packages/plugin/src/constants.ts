// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageName = "@holycodex/plugin" as const;

export const VERSION_PATTERN = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
export const EPOCH_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/u;
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/u;
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export const SOURCE_MANIFEST_PATH = ".codex-plugin/plugin.json";
export const PAYLOAD_MANIFEST_PATH = ".codex-plugin/payload.json";
export const DEFAULT_SCHEMA_EPOCH = "plugin-1";

export const GENERATED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".turbo",
  ".vite",
  ".vite-plus",
  ".vp",
  ".vp-cache",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "payloads",
  "scratch",
  "temp",
  "tmp",
]);

export const SECRET_PATH_PATTERN =
  /(?:^|[._-])(access[_-]?key|api[_-]?key|authorization|cookie|credential(?:s)?|env|id_rsa|password|passwd|private[_-]?key|secret(?:s)?|session|token(?:s)?)(?:$|[._-])/iu;
export const SECRET_EXTENSION_PATTERN = /\.(?:env|key|pem|pfx|p12|crt)$/iu;

export const MAX_FILE_SIZE = 1024 * 1024;
export const MAX_TOTAL_SIZE = 8 * 1024 * 1024;

export const pluginSourceRoot = resolve(fileURLToPath(new URL("../assets/", import.meta.url)));
