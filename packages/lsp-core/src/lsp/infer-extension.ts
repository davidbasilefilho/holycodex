// SPDX-License-Identifier: Apache-2.0

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { effectiveExtension } from "./effective-extension.ts";
import { EXT_TO_LANG } from "./language-mappings.ts";

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

/** Infers the most common supported source extension in a directory. */
export function inferExtensionFromDirectory(directory: string, maxEntries = 500): string | null {
  const counts = new Map<string, number>();
  let scanned = 0;
  const walk = (current: string): void => {
    if (scanned >= maxEntries) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= maxEntries) return;
      const path = join(current, entry);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) continue;
        scanned += 1;
        if (stat.isDirectory()) {
          if (!skipped.has(entry)) walk(path);
        } else if (stat.isFile()) {
          const extension = effectiveExtension(path);
          if (extension in EXT_TO_LANG) counts.set(extension, (counts.get(extension) ?? 0) + 1);
        }
      } catch {
        /* inaccessible entries are intentionally skipped */
      }
    }
  };
  walk(directory);
  let selected: string | null = null;
  let count = 0;
  for (const [extension, value] of counts) {
    if (value > count) {
      selected = extension;
      count = value;
    }
  }
  return selected;
}
