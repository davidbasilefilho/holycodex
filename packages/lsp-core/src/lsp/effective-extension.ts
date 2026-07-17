import { basename, extname } from "node:path";

const BASENAME_EXTENSIONS: Record<string, string> = {
  Dockerfile: ".dockerfile",
  Containerfile: ".dockerfile",
};

/** Provides effective extension. */
export function effectiveExtension(filePath: string): string {
  return BASENAME_EXTENSIONS[basename(filePath)] ?? extname(filePath);
}
