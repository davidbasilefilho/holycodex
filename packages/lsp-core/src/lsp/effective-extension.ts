// SPDX-License-Identifier: Apache-2.0

import { basename, extname } from "node:path";

const specialNames: Readonly<Record<string, string>> = {
  Dockerfile: ".dockerfile",
  Containerfile: ".dockerfile",
};

/** Returns the LSP extension for normal and extensionless source filenames. */
export function effectiveExtension(filePath: string): string {
  return specialNames[basename(filePath)] ?? extname(filePath).toLowerCase();
}
