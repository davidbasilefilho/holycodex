// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_VERSION_PATTERN } from "@holycodex/core";

/** Canonical package identifier for the plugin workspace package. */
export const packageName = "@holycodex/plugin" as const;

/** Regular expression matching canonical HolyCodex versions. */
export const VERSION_PATTERN = CANONICAL_VERSION_PATTERN;
/** Regular expression matching payload schema epoch identifiers. */
export const EPOCH_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/u;
/** Regular expression matching supported Codex plugin names. */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/u;
/** Regular expression matching shipped skill directory names. */
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
/** Regular expression matching lowercase SHA-256 digests. */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/** Relative path of the source and generated Codex plugin manifest. */
export const SOURCE_MANIFEST_PATH = ".codex-plugin/plugin.json";
/** Relative path of the generated payload integrity manifest. */
export const PAYLOAD_MANIFEST_PATH = ".codex-plugin/payload.json";
/** Default schema epoch used when creating a plugin payload. */
export const DEFAULT_SCHEMA_EPOCH = "plugin-1";

/** Directory names excluded from source payloads as generated or cached output. */
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

/** Matches path components that may disclose credentials or private state. */
export const SECRET_PATH_PATTERN =
  /(?:^|[._-])(access[_-]?key|api[_-]?key|authorization|cookie|credential(?:s)?|env|id_rsa|password|passwd|private[_-]?key|secret(?:s)?|session|token(?:s)?)(?:$|[._-])/iu;
/** Matches file extensions commonly used for secrets and private keys. */
export const SECRET_EXTENSION_PATTERN = /\.(?:env|key|pem|pfx|p12|crt)$/iu;

/** Maximum permitted size of one plugin asset, in bytes. */
export const MAX_FILE_SIZE = 1024 * 1024;
/** Maximum permitted combined size of plugin assets, in bytes. */
export const MAX_TOTAL_SIZE = 8 * 1024 * 1024;

/** Resolved root of the checked-in plugin asset tree. */
export const pluginSourceRoot = resolve(fileURLToPath(new URL("../assets/", import.meta.url)));
