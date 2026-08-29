// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const WINDOWS_GIT_BASH_INSTRUCTION =
  " Use C:/Program Files/Git/bin/bash.exe for every shell command.";
type VersionManifest = Readonly<{ readonly version: string }>;

export function renderVersionContext(version: string, platform: NodeJS.Platform): string {
  const suffix = platform === "win32" ? WINDOWS_GIT_BASH_INSTRUCTION : "";
  return `HolyCodex ${version}.${suffix}`;
}

export function renderSessionStartOutput(
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: renderVersionContext(version, platform),
    },
  })}\n`;
}

export async function readInstalledPluginVersion(pluginRoot: string): Promise<string> {
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isVersionManifest(parsed)) {
    throw new Error("HolyCodex plugin manifest has no valid version.");
  }
  return parsed.version;
}

function isVersionManifest(value: unknown): value is VersionManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "version" in value &&
    typeof value.version === "string" &&
    VERSION_PATTERN.test(value.version)
  );
}

if (import.meta.main) {
  const pluginRoot = process.env["PLUGIN_ROOT"]?.trim();
  if (!pluginRoot) {
    throw new Error("PLUGIN_ROOT is required.");
  }
  process.stdout.write(await readInstalledPluginVersion(pluginRoot).then(renderSessionStartOutput));
}
