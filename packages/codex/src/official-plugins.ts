// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import {
  checked,
  CodexError,
  failure,
  invalidData,
  isPlainObject,
  isValid,
  JsonValueSchema,
  success,
  TextSchema,
  type CodexResult,
} from "./common";

const PluginNameSchema = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9._-]{1,63}$/u));
const PluginVersionSchema = Schema.String.pipe(
  Schema.pattern(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u),
);
const StringArraySchema = Schema.Array(Schema.String);

export const OfficialPluginManifestSchema = Schema.Struct({
  name: PluginNameSchema,
  version: PluginVersionSchema,
  description: TextSchema,
  author: Schema.optional(JsonValueSchema),
  license: Schema.optional(TextSchema),
  homepage: Schema.optional(TextSchema),
  repository: Schema.optional(TextSchema),
  keywords: Schema.optional(StringArraySchema),
  skills: Schema.optional(StringArraySchema),
  commands: Schema.optional(StringArraySchema),
  hooks: Schema.optional(StringArraySchema),
  assets: Schema.optional(StringArraySchema),
  official: Schema.optional(Schema.Boolean),
});
export type OfficialPluginManifest = typeof OfficialPluginManifestSchema.Type;

export interface OfficialPluginVerification {
  readonly manifest: OfficialPluginManifest;
  readonly manifestPath?: string;
  readonly explicitlySelected: boolean;
}

function containsMcpDeclaration(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsMcpDeclaration(item));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/mcp|model[._-]?context[._-]?protocol/iu.test(key)) {
      return true;
    }
    if (containsMcpDeclaration(item)) {
      return true;
    }
  }
  return false;
}

export function parseOfficialPluginManifest(input: unknown): CodexResult<OfficialPluginManifest> {
  if (containsMcpDeclaration(input)) {
    return failure(
      new CodexError("manifest_invalid", "HolyCodex-owned plugin payloads cannot declare MCP."),
    );
  }
  if (!isValid(OfficialPluginManifestSchema, input)) {
    return failure(invalidData("official plugin manifest", input));
  }
  return success(checked(OfficialPluginManifestSchema, input, "official plugin manifest"));
}

export function verifyOfficialPluginManifest(input: unknown): OfficialPluginVerification {
  const parsed = parseOfficialPluginManifest(input);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return { manifest: parsed.value, explicitlySelected: false };
}

export async function verifyOfficialPluginManifestFile(
  pluginRoot: string,
): Promise<OfficialPluginVerification> {
  let root: string;
  try {
    root = await realpath(pluginRoot);
    if (!(await stat(root)).isDirectory()) {
      throw new Error("plugin root is not a directory");
    }
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The official plugin root is invalid.",
      {},
      { cause: error },
    );
  }
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  let contents: string;
  try {
    const manifestEntry = await lstat(manifestPath);
    if (manifestEntry.isSymbolicLink() || !manifestEntry.isFile()) {
      throw new Error("plugin manifest is not a regular file");
    }
    contents = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(manifestPath));
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The plugin is missing .codex-plugin/plugin.json.",
      {},
      { cause: error },
    );
  }
  let parsedJson: unknown;
  try {
    // JSON.parse is immediately validated by the manifest schema and MCP-key scan.
    parsedJson = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    throw new CodexError(
      "manifest_invalid",
      "The plugin manifest is not valid JSON.",
      {},
      { cause: error },
    );
  }
  const verification = verifyOfficialPluginManifest(parsedJson);
  return { ...verification, manifestPath };
}

export const OfficialPluginSelectionSchema = Schema.Struct({
  id: PluginNameSchema,
  selected: Schema.Literal(true),
});
export type OfficialPluginSelection = typeof OfficialPluginSelectionSchema.Type;

export function selectOfficialPlugins(
  available: readonly OfficialPluginManifest[],
  selections: readonly OfficialPluginSelection[],
): readonly OfficialPluginVerification[] {
  const byName = new Map(available.map((manifest) => [manifest.name, manifest]));
  const output: OfficialPluginVerification[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const parsedSelection = checked(
      OfficialPluginSelectionSchema,
      selection,
      "official plugin selection",
    );
    if (seen.has(parsedSelection.id)) {
      throw new CodexError("manifest_invalid", "An official plugin was selected more than once.", {
        id: parsedSelection.id,
      });
    }
    const manifest = byName.get(parsedSelection.id);
    if (!manifest) {
      throw new CodexError(
        "manifest_invalid",
        "An explicitly selected official plugin is unavailable.",
        {
          id: parsedSelection.id,
        },
      );
    }
    seen.add(parsedSelection.id);
    output.push({ manifest, explicitlySelected: true });
  }
  return output;
}
